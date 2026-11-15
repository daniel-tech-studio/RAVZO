import 'dart:convert';
import 'dart:math';
import 'package:cryptography/cryptography.dart';
import 'store.dart';

/// Clé d'appareil Ed25519 : la graine privée reste dans Keychain/Keystore, seule la clé publique est envoyée (B13, llm §4.4).
class DeviceKey {
  final SecureStore store;
  final _ed = Ed25519();
  SimpleKeyPair? _pair;
  DeviceKey(this.store);

  Future<void> ensure() async {
    var seed = await store.secret('device_seed');
    if (seed == null) { final r = Random.secure(); seed = base64Encode(List.generate(32, (_) => r.nextInt(256))); await store.setSecret('device_seed', seed); }
    _pair = await _ed.newKeyPairFromSeed(base64Decode(seed));
  }
  Future<String> publicKeyB64() async => base64Encode((await _pair!.extractPublicKey()).bytes);
  /// Signature du message de défi serveur ; format attendu : `<base64sig>.<nonce>`.
  Future<Map<String, String>> signChallenge(Map ch) async {
    final sig = await _ed.sign(utf8.encode(ch['message'] as String), keyPair: _pair!);
    return {'challengeId': ch['challengeId'] as String, 'signature': '${base64Encode(sig.bytes)}.${ch['nonce']}'};
  }
  Future<void> rotate() async { await store.setSecret('device_seed', null); await ensure(); }
}
