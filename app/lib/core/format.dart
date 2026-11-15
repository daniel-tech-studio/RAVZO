import 'package:intl/intl.dart';

/// Format XOF « 150 000 FCFA » à partir d'unités mineures en chaîne (jamais de double pour l'argent).
String money(String? minor, {bool hidden = false, bool signed = false, bool compact = false, String unit = 'FCFA'}) {
  if (hidden) return '•••••• $unit';
  if (minor == null || minor.isEmpty) return '— $unit';
  final neg = minor.startsWith('-');
  final digits = neg ? minor.substring(1) : minor;
  String body;
  if (compact && digits.length > 6) {
    final big = BigInt.parse(digits);
    final m = big ~/ BigInt.from(1000000), r = (big % BigInt.from(1000000)) ~/ BigInt.from(100000);
    body = '${_group(m.toString())}${r > BigInt.zero ? ',$r' : ''} M';
  } else {
    body = _group(digits);
  }
  final sign = neg ? '−' : (signed && digits != '0' ? '+' : '');
  return '$sign$body $unit';
}
String _group(String d) => d.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ' ');

BigInt big(String? s) => BigInt.tryParse(s ?? '') ?? BigInt.zero;
int pct(String? part, String? total) { final t = big(total); return t == BigInt.zero ? 0 : (big(part) * BigInt.from(100) ~/ t).toInt(); }
double ratio(String? part, String? total) { final t = big(total); if (t == BigInt.zero) return 0; return (big(part) * BigInt.from(10000) ~/ t).toInt() / 10000; }

/// Saisie utilisateur « 150 000 » → « 150000 » (unités mineures XOF) ; null si invalide.
String? parseAmountInput(String s) { final c = s.replaceAll(RegExp(r'[\s  .]'), ''); return RegExp(r'^\d{1,13}$').hasMatch(c) && c != '0' ? BigInt.parse(c).toString() : null; }

final _d = DateFormat('d MMM yyyy', 'fr');
final _dm = DateFormat('d MMM', 'fr');
final _dt = DateFormat('d MMM yyyy à HH:mm', 'fr');
/// Affichage dans le fuseau Africa/Porto-Novo (UTC+1, sans heure d'été) — stockage serveur UTC.
DateTime toLocalBj(DateTime utc) => utc.toUtc().add(const Duration(hours: 1));
String fmtDate(String? iso) { if (iso == null) return '—'; final d = DateTime.tryParse(iso); return d == null ? iso : _d.format(iso.length <= 10 ? d : toLocalBj(d)); }
String fmtDay(String? iso) { if (iso == null) return '—'; final d = DateTime.tryParse(iso); return d == null ? iso : _dm.format(iso.length <= 10 ? d : toLocalBj(d)); }
String fmtDateTime(String? iso) { if (iso == null) return '—'; final d = DateTime.tryParse(iso); return d == null ? iso : _dt.format(toLocalBj(d)); }
String relative(String? iso) {
  final d = DateTime.tryParse(iso ?? '');
  if (d == null) return '—';
  final diff = DateTime.now().toUtc().difference(d.toUtc());
  if (diff.inSeconds < 60) return 'à l’instant';
  if (diff.inMinutes < 60) return 'il y a ${diff.inMinutes} min';
  if (diff.inHours < 24) return 'il y a ${diff.inHours} h';
  return 'il y a ${diff.inDays} j';
}
String countdown(Duration d) { if (d.isNegative || d == Duration.zero) return 'maintenant'; final h = d.inHours, m = d.inMinutes % 60; return h >= 24 ? '${h ~/ 24} j ${h % 24} h' : '$h h ${m.toString().padLeft(2, '0')} min'; }
String isoDate(DateTime d) => DateFormat('yyyy-MM-dd').format(d);
