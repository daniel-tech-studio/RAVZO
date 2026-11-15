import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

/// Coffre local : secrets dans Keychain/Keystore ; cache et brouillons dans un fichier chiffré AES-256-GCM
/// dont la clé vit dans le stockage sécurisé (llm.md §4.3 « cache local minimal chiffré »).
class SecureStore {
  static const _secure = FlutterSecureStorage(
    mOptions: MacOsOptions(usesDataProtectionKeychain: false, accountName: 'bj.ravzo.ravzo.secure', accessibility: KeychainAccessibility.first_unlock_this_device),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
  );
  final _aes = AesGcm.with256bits();
  SecretKey? _key;
  Map<String, dynamic> _cache = {};
  File? _file;

  Future<String?> secret(String k) => _secure.read(key: k);
  Future<void> setSecret(String k, String? v) => v == null ? _secure.delete(key: k) : _secure.write(key: k, value: v);

  Future<void> open() async {
    var k = await secret('cache_key');
    if (k == null) { final r = Random.secure(); k = base64Encode(List.generate(32, (_) => r.nextInt(256))); await setSecret('cache_key', k); }
    _key = SecretKey(base64Decode(k));
    final dir = await getApplicationSupportDirectory();
    _file = File('${dir.path}/ravzo-cache.bin');
    if (await _file!.exists()) {
      try {
        final raw = await _file!.readAsBytes();
        final box = SecretBox.fromConcatenation(raw, nonceLength: 12, macLength: 16);
        _cache = jsonDecode(utf8.decode(await _aes.decrypt(box, secretKey: _key!))) as Map<String, dynamic>;
      } catch (_) { _cache = {}; }
    }
  }
  T? get<T>(String k) => _cache[k] as T?;
  Future<void> put(String k, Object? v) async {
    if (v == null) { _cache.remove(k); } else { _cache[k] = v; }
    final box = await _aes.encrypt(utf8.encode(jsonEncode(_cache)), secretKey: _key!);
    await _file!.writeAsBytes(box.concatenation(), flush: true);
  }
  /// Effacement local (déconnexion/révocation). Un appareil perdu hors ligne ne peut pas être purgé à distance (llm §4.4).
  Future<void> wipe({bool keepDeviceKey = true}) async {
    _cache = {};
    if (_file != null && await _file!.exists()) await _file!.delete();
    for (final k in ['access', 'refresh']) { await setSecret(k, null); }
    if (!keepDeviceKey) await setSecret('device_seed', null);
  }
}
