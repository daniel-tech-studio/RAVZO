import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'store.dart';

class ApiError implements Exception {
  final int status;
  final String code, message;
  final Map<String, dynamic> details;
  ApiError(this.status, this.code, this.message, [this.details = const {}]);
  bool get offline => code == 'OFFLINE';
  bool get stepUp => code == 'STEP_UP_REQUIRED' || code.startsWith('SIGNED_APPROVAL');
  @override
  String toString() => message;
}

String newIdempotencyKey() { final r = Random.secure(); return 'rv-${DateTime.now().microsecondsSinceEpoch}-${List.generate(10, (_) => r.nextInt(36).toRadixString(36)).join()}'; }

/// Client REST /api/v1 : enveloppe {data, meta}, erreurs normalisées, rotation du refresh, clés d'idempotence.
class Api {
  String baseUrl;
  final SecureStore store;
  String? _access;
  Future<bool>? _refreshing;
  void Function()? onSessionLost;
  DateTime? lastServerTime;
  final _online = StreamController<bool>.broadcast();
  bool online = true;
  Stream<bool> get onlineChanges => _online.stream;

  Api(this.baseUrl, this.store);

  Future<void> loadTokens() async { _access = await store.secret('access'); }
  Future<void> setTokens(String access, String refresh) async { _access = access; await store.setSecret('access', access); await store.setSecret('refresh', refresh); }
  bool get hasSession => _access != null;
  String? get accessToken => _access;
  Future<void> clearTokens() async { _access = null; await store.setSecret('access', null); await store.setSecret('refresh', null); }

  void _setOnline(bool v) { if (online != v) { online = v; _online.add(v); } }

  Future<dynamic> get(String path, {Map<String, String?>? query}) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body, bool idempotent = false, String? key]) => _send('POST', path, body: body ?? {}, idemKey: idempotent ? (key ?? newIdempotencyKey()) : null);
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body: body);
  Future<dynamic> delete(String path, [Object? body]) => _send('DELETE', path, body: body);

  Future<http.Response> raw(String method, String path, {Map<String, String>? headers, List<int>? bytes, Map<String, String?>? query}) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query?..removeWhere((k, v) => v == null || v.isEmpty));
    final req = http.Request(method, uri)..headers.addAll({if (_access != null) 'Authorization': 'Bearer $_access', ...?headers});
    if (bytes != null) req.bodyBytes = bytes;
    try { return await http.Response.fromStream(await req.send().timeout(const Duration(seconds: 30))); } on SocketException { _setOnline(false); throw ApiError(0, 'OFFLINE', 'Hors ligne : serveur injoignable'); } on TimeoutException { throw ApiError(0, 'OFFLINE', 'Délai dépassé'); }
  }

  Future<dynamic> _send(String method, String path, {Object? body, String? idemKey, Map<String, String?>? query, bool retried = false}) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query == null ? null : (Map.of(query)..removeWhere((k, v) => v == null || v.isEmpty)));
    final headers = {'Content-Type': 'application/json', 'Accept': 'application/json', if (_access != null) 'Authorization': 'Bearer $_access', if (idemKey != null) 'Idempotency-Key': idemKey};
    http.Response r;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null && method != 'GET') req.body = jsonEncode(body);
      r = await http.Response.fromStream(await req.send().timeout(const Duration(seconds: 25)));
      _setOnline(true);
    } on SocketException { _setOnline(false); throw ApiError(0, 'OFFLINE', 'Hors ligne : serveur injoignable'); } on TimeoutException { throw ApiError(0, 'OFFLINE', 'Délai dépassé — le résultat d’une opération sensible doit être vérifié avant tout nouvel essai'); } on http.ClientException { _setOnline(false); throw ApiError(0, 'OFFLINE', 'Connexion impossible'); }
    final ct = r.headers['content-type'] ?? '';
    final json = ct.contains('json') && r.body.isNotEmpty ? jsonDecode(r.body) : null;
    if (json is Map && json['meta']?['serverTime'] != null) lastServerTime = DateTime.tryParse(json['meta']['serverTime']);
    if (r.statusCode >= 200 && r.statusCode < 300) return json is Map && json.containsKey('data') ? (json['page'] != null ? {'items': json['data'], ...json['page']} : json['data']) : json;
    final err = json is Map ? json['error'] as Map? : null;
    final code = err?['code']?.toString() ?? 'HTTP_${r.statusCode}';
    if (r.statusCode == 401 && !retried && path != '/identity/refresh' && path != '/identity/login') {
      if (await _refresh()) return _send(method, path, body: body, idemKey: idemKey, query: query, retried: true);
      onSessionLost?.call();
    }
    throw ApiError(r.statusCode, code, err?['message']?.toString() ?? 'Erreur ${r.statusCode}', (err?['details'] as Map?)?.cast<String, dynamic>() ?? {});
  }

  Future<bool> _refresh() {
    return _refreshing ??= () async {
      try {
        final rt = await store.secret('refresh');
        if (rt == null) return false;
        final d = await _send('POST', '/identity/refresh', body: {'refreshToken': rt}, retried: true);
        await setTokens(d['accessToken'], d['refreshToken']);
        return true;
      } catch (_) { return false; } finally { Future.microtask(() => _refreshing = null); }
    }();
  }
}
