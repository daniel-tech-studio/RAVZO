import 'dart:async';
import 'dart:io' show Platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import '../firebase_options.dart';
import 'api.dart';

/// Notifications push via Firebase Cloud Messaging (Android, iOS, macOS).
/// L'app n'envoie rien : elle inscrit son jeton FCM auprès du serveur RAVZO (appareil de confiance uniquement).
/// iOS/macOS exigent une clé APNs déposée dans Firebase (compte Apple Developer) ; sans elle, l'état l'indique.
class PushReceiver {
  final Api api;
  String status = 'Inactif';
  bool _started = false;
  StreamSubscription? _refresh, _fg, _opened;
  void Function(RemoteMessage m)? onMessage;
  void Function(String link)? onOpenLink;
  void Function()? onStatus;
  PushReceiver(this.api);

  static Future<void> init() async {
    if (Firebase.apps.isEmpty) await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  }
  String get _platform => Platform.isAndroid ? 'android' : Platform.isIOS ? 'ios' : 'macos';
  void _set(String s) { status = s; onStatus?.call(); }

  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      await init();
      final fm = FirebaseMessaging.instance;
      final perm = await fm.requestPermission(alert: true, badge: true, sound: true);
      if (perm.authorizationStatus == AuthorizationStatus.denied) { _set('Refusées dans les réglages du système'); return; }
      if (Platform.isIOS || Platform.isMacOS) {
        final apns = await fm.getAPNSToken().timeout(const Duration(seconds: 8), onTimeout: () => null);
        if (apns == null) { _set('Non disponibles sur cet appareil'); _listen(); return; }
      }
      final token = await fm.getToken();
      if (token == null) { _set('Jeton indisponible'); return; }
      await _register(token);
      _refresh = fm.onTokenRefresh.listen(_register);
      _listen();
    } on ApiError catch (e) { _set('Inscription refusée : ${e.message}'); }
    catch (e) {
      final t = e.toString();
      _set(t.contains('apns-token-not-set') ? 'Non disponibles sur cet appareil' : 'Indisponibles pour le moment');
    }
  }

  Future<void> _register(String token) async {
    final r = await api.post('/notifications/push-devices', {'token': token, 'platform': _platform});
    _set(r['configured'] == true ? 'Activées' : 'Indisponibles pour le moment');
  }

  void _listen() {
    _fg ??= FirebaseMessaging.onMessage.listen((m) => onMessage?.call(m));
    _opened ??= FirebaseMessaging.onMessageOpenedApp.listen((m) { final l = m.data['link']; if (l is String && l.isNotEmpty) onOpenLink?.call(l); });
    FirebaseMessaging.instance.getInitialMessage().then((m) { final l = m?.data['link']; if (l is String && l.isNotEmpty) onOpenLink?.call(l); });
  }

  /// À la déconnexion : désinscription serveur puis suppression du jeton local.
  Future<void> stop() async {
    try { await api.delete('/notifications/push-devices/current'); } catch (_) {}
    try { if (Firebase.apps.isNotEmpty) await FirebaseMessaging.instance.deleteToken(); } catch (_) {}
    await _refresh?.cancel(); await _fg?.cancel(); await _opened?.cancel();
    _refresh = _fg = _opened = null; _started = false; _set('Inactif');
  }
}
