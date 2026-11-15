import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'api.dart';
import 'device_key.dart';
import 'push.dart';
import 'store.dart';

enum SessionPhase { booting, signedOut, pendingDevice, ready }

/// État applicatif : session, appareil, préférences, temps réel (SSE + deltas), brouillons hors ligne.
class AppState extends ChangeNotifier {
  final SecureStore store = SecureStore();
  late final Api api;
  late final DeviceKey key;
  late final PushReceiver push;
  Map<String, dynamic>? lastPush;
  /// Lien ouvert depuis une notification, consommé par le shell.
  String? pendingLink;
  SessionPhase phase = SessionPhase.booting;
  Map<String, dynamic>? me;
  Map<String, dynamic>? pendingEnrollment;
  bool bootstrapAvailable = false;

  // Préférences persistées (llm §2.6, §3.4, UX16, UX23)
  ThemeMode themeMode = ThemeMode.system;
  bool hideAmounts = false;
  bool reduceMotion = false;
  List<String> widgetOrder = const ['alerts', 'budget', 'savings', 'forecast', 'wealth', 'liabilities', 'brvm', 'recent'];
  Set<String> hiddenWidgets = {};
  Map<String, int> actionUsage = {};

  // Temps réel
  int revision = 0;
  String? cursor;
  DateTime? lastSync;
  bool streamConnected = false;
  StreamSubscription? _sse;
  http.Client? _sseClient;
  Timer? _reconnect;
  bool _connecting = false;
  int needsIntervention = 0, unreadCritical = 0, unread = 0;

  AppState({String? baseUrl}) {
    api = Api(baseUrl ?? const String.fromEnvironment('RAVZO_API', defaultValue: 'https://ravzo-api.72-60-186-169.sslip.io/api/v1'), store);
    key = DeviceKey(store);
    push = PushReceiver(api)
      ..onStatus = notifyListeners
      ..onMessage = (m) { lastPush = {'title': m.notification?.title, 'body': m.notification?.body, ...m.data}; refreshBadges(); bump(); }
      ..onOpenLink = (l) { pendingLink = l; notifyListeners(); };
    api.onSessionLost = () => signOut(local: true);
    api.onlineChanges.listen((on) { notifyListeners(); if (on) _connectStream(); });
  }

  String get platform => Platform.isMacOS ? 'macos' : Platform.isIOS ? 'ios' : Platform.isAndroid ? 'android' : 'test';
  bool get online => api.online;

  Future<void> boot() async {
    await store.open();
    await key.ensure();
    final p = store.get<Map>('prefs') ?? {};
    themeMode = ThemeMode.values.firstWhere((m) => m.name == p['theme'], orElse: () => ThemeMode.system);
    hideAmounts = p['hideAmounts'] == true;
    reduceMotion = p['reduceMotion'] == true;
    if (p['widgetOrder'] is List) widgetOrder = List<String>.from(p['widgetOrder']);
    if (p['hiddenWidgets'] is List) hiddenWidgets = Set<String>.from(p['hiddenWidgets']);
    if (p['actionUsage'] is Map) actionUsage = Map<String, int>.from(p['actionUsage']);
    cursor = store.get<String>('cursor');
    final ls = store.get<String>('lastSync');
    lastSync = ls == null ? null : DateTime.tryParse(ls);
    await api.loadTokens();
    if (!api.hasSession) { phase = SessionPhase.signedOut; notifyListeners(); return; }
    await refreshMe();
  }

  Future<void> refreshMe() async {
    try {
      me = await api.get('/identity/me');
      await store.put('me', me);
      phase = me!['device']?['status'] == 'ACTIVE' ? SessionPhase.ready : SessionPhase.pendingDevice;
      if (phase == SessionPhase.ready) { _connectStream(); refreshBadges(); push.start(); }
    } on ApiError catch (e) {
      if (e.offline && store.get<Map>('me') != null) { me = Map<String, dynamic>.from(store.get<Map>('me')!); phase = SessionPhase.ready; }
      else if (e.status == 401) { phase = SessionPhase.signedOut; }
      else if (e.code == 'UNTRUSTED_DEVICE') { phase = SessionPhase.pendingDevice; }
      else { phase = SessionPhase.signedOut; }
    }
    notifyListeners();
  }

  Future<void> savePrefs() => store.put('prefs', {'theme': themeMode.name, 'hideAmounts': hideAmounts, 'reduceMotion': reduceMotion, 'widgetOrder': widgetOrder, 'hiddenWidgets': hiddenWidgets.toList(), 'actionUsage': actionUsage});
  void setTheme(ThemeMode m) { themeMode = m; savePrefs(); notifyListeners(); }
  void toggleAmounts() { hideAmounts = !hideAmounts; savePrefs(); notifyListeners(); }
  void setReduceMotion(bool v) { reduceMotion = v; savePrefs(); notifyListeners(); }
  void setWidgets(List<String> order, Set<String> hidden) { widgetOrder = order; hiddenWidgets = hidden; savePrefs(); notifyListeners(); }
  /// UX02 : raccourcis adaptés à l'usage — on compte, on ne lance jamais rien automatiquement.
  void countAction(String id) { actionUsage[id] = (actionUsage[id] ?? 0) + 1; savePrefs(); }

  // ─── Session ───
  Future<Map> login(String email, String password, String deviceName) async {
    final d = await api.post('/identity/login', {'email': email, 'password': password, 'device': {'publicKey': await key.publicKeyB64(), 'name': deviceName, 'platform': platform}});
    await api.setTokens(d['accessToken'], d['refreshToken']);
    bootstrapAvailable = d['bootstrapAvailable'] == true;
    await refreshMe();
    return d;
  }
  Future<void> bootstrapEnroll(String code) async { await api.post('/devices/enrollment-requests/bootstrap', {'code': code}); await refreshMe(); }
  Future<Map> requestEnrollment() async { pendingEnrollment = Map<String, dynamic>.from(await api.post('/devices/enrollment-requests')); notifyListeners(); return pendingEnrollment!; }
  Future<Map> startRecovery(String email) async => Map<String, dynamic>.from(await api.post('/recovery/start', {'email': email}));
  Future<Map> verifyRecovery(Map start, String code, String? newPassword, String deviceName) async {
    final d = await api.post('/recovery/verify', {'recoveryId': start['recoveryId'], 'challenge': start['challenge'], 'recoveryCode': code, if (newPassword != null && newPassword.isNotEmpty) 'newPassword': newPassword, 'device': {'publicKey': await key.publicKeyB64(), 'name': deviceName, 'platform': platform}});
    await api.setTokens(d['accessToken'], d['refreshToken']);
    await refreshMe();
    return d;
  }
  Future<void> signOut({bool local = false}) async {
    if (!local) { try { await api.post('/identity/logout'); } catch (_) {} }
    await push.stop();
    _sse?.cancel(); _sseClient?.close(); _reconnect?.cancel();
    _sse = null; _sseClient = null; _connecting = false;
    await api.clearTokens();
    await store.put('me', null);
    me = null; phase = SessionPhase.signedOut; streamConnected = false;
    notifyListeners();
  }

  /// Preuve forte : challenge serveur lié aux paramètres EXACTS, signé par la clé de l'appareil (jamais une simple biométrie locale).
  Future<Map<String, String>> approve(String action, Map<String, dynamic> params) async => key.signChallenge(await api.post('/security/challenges', {'action': action, 'params': params}));

  // ─── Temps réel : SSE après commit + rattrapage par curseur ───
  void bump() { revision++; notifyListeners(); }
  Future<void> catchUp() async {
    try {
      var c = cursor;
      for (var i = 0; i < 10; i++) {
        final d = await api.get('/sync/changes', query: {'cursor': c});
        if (d['resyncRequired'] == true) { c = d['nextCursor']; break; }
        c = d['nextCursor'];
        if (d['hasMore'] != true) break;
      }
      cursor = c; lastSync = DateTime.now(); await store.put('cursor', c); await store.put('lastSync', lastSync!.toIso8601String());
      bump();
    } catch (_) {}
  }
  Future<void> refreshBadges() async {
    try {
      final ops = await api.get('/operations');
      final n = await api.get('/notifications', query: {'unreadOnly': 'true'});
      needsIntervention = ops['needsInterventionCount'] ?? 0; unread = n['unreadCount'] ?? 0; unreadCritical = n['criticalUnreadCount'] ?? 0;
      notifyListeners();
    } catch (_) {}
  }
  void _connectStream() async {
    if (phase != SessionPhase.ready || _sse != null || _connecting) return;
    _connecting = true;
    _reconnect?.cancel();
    await catchUp();
    try {
      _sseClient = http.Client();
      final req = http.Request('GET', Uri.parse('${api.baseUrl}/events/stream'))..headers.addAll({'Authorization': 'Bearer ${api.accessToken}', 'Accept': 'text/event-stream', if (cursor != null) 'Last-Event-ID': cursor!});
      final resp = await _sseClient!.send(req);
      if (resp.statusCode != 200) throw Exception('sse ${resp.statusCode}');
      streamConnected = true; _connecting = false; notifyListeners();
      String? id, event;
      Timer? debounce;
      _sse = resp.stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        if (line.startsWith('id: ')) id = line.substring(4);
        if (line.startsWith('event: ')) event = line.substring(7);
        if (line.isEmpty && event != null) {
          if (id != null) { cursor = id; store.put('cursor', id); }
          lastSync = DateTime.now();
          if (event == 'session.revoked') { signOut(local: true); return; }
          debounce?.cancel();
          debounce = Timer(const Duration(milliseconds: 350), () { bump(); refreshBadges(); });
          id = null; event = null;
        }
      }, onDone: _lost, onError: (_) => _lost(), cancelOnError: true);
    } catch (_) { _connecting = false; _lost(); }
  }
  void _lost() {
    _sse = null; streamConnected = false; _sseClient?.close(); notifyListeners();
    if (phase == SessionPhase.ready) _reconnect = Timer(const Duration(seconds: 5), _connectStream);
  }

  // ─── Brouillons hors ligne (D44) : enregistrés localement, jamais envoyés sans confirmation individuelle ───
  List<Map<String, dynamic>> get localDrafts => (store.get<List>('drafts') ?? []).map((e) => Map<String, dynamic>.from(e)).toList();
  Future<void> addLocalDraft(String target, Map<String, dynamic> payload, {String op = 'CREATE', String? targetId, int? baseVersion}) async {
    final list = localDrafts..add({'clientDraftId': 'd-${DateTime.now().microsecondsSinceEpoch}', 'targetResource': target, 'operation': op, 'targetId': targetId, 'baseVersion': baseVersion, 'payload': payload, 'createdAt': DateTime.now().toUtc().toIso8601String()});
    await store.put('drafts', list); notifyListeners();
  }
  Future<void> removeLocalDraft(String id) async { await store.put('drafts', localDrafts.where((d) => d['clientDraftId'] != id).toList()); notifyListeners(); }

  /// Lecture avec repli sur le cache chiffré si hors ligne (données marquées « ancien »).
  Future<(dynamic, bool)> cached(String path, {Map<String, String?>? query}) async {
    final k = 'c:$path${query == null ? '' : jsonEncode(query)}';
    try { final d = await api.get(path, query: query); await store.put(k, {'at': DateTime.now().toUtc().toIso8601String(), 'd': d}); return (d, false); }
    on ApiError catch (e) { final c = store.get<Map>(k); if (e.offline && c != null) return (c['d'], true); rethrow; }
  }
  String? cachedAt(String path) => (store.get<Map>('c:$path'))?['at'];
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext c) => c.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
extension AppX on BuildContext { AppState get app => AppScope.of(this); AppState get appRead => AppScope.read(this); }
