import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/api.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import 'motion.dart';
import 'theme.dart';
import 'tokens.dart';

/// Montant respectant le masquage global (UX23), chiffres tabulaires.
class Money extends StatelessWidget {
  final String? minor;
  final double size;
  final FontWeight weight;
  final Color? color;
  final bool signed, compact, display, colorize;
  const Money(this.minor, {super.key, this.size = 15, this.weight = FontWeight.w600, this.color, this.signed = false, this.compact = false, this.display = false, this.colorize = false});
  @override
  Widget build(BuildContext context) {
    final hidden = context.app.hideAmounts;
    final p = context.pal;
    final neg = (minor ?? '').startsWith('-');
    final c = color ?? (colorize ? (neg ? p.error : (signed && minor != '0' ? p.success : p.ink)) : p.ink);
    final txt = money(minor, hidden: hidden, signed: signed, compact: compact);
    final style = display ? sora(size, w: weight, color: c) : inter(size, w: weight, color: c, tab: true);
    return Semantics(label: hidden ? 'Montant masqué' : txt, excludeSemantics: true, child: SwapValue(valueKey: '$txt$hidden', child: Text(txt, style: style, maxLines: 1, overflow: TextOverflow.fade, softWrap: false)));
  }
}

/// Étiquettes de provenance obligatoires (llm §3.3) : confirmé, suivi, prévisionnel, estimé, différé, ancien, à rapprocher, simulé.
class DataLabel extends StatelessWidget {
  final String kind;
  final bool onDark;
  const DataLabel(this.kind, {super.key, this.onDark = false});
  static const _map = {
    'CONFIRMED': ('Confirmé', Icons.verified_rounded), 'MANUAL': ('Suivi manuellement', Icons.edit_note_rounded), 'TRACKED': ('Suivi', Icons.edit_note_rounded),
    'FORECAST': ('Prévisionnel', Icons.timeline_rounded), 'ESTIMATED': ('Estimé', Icons.auto_graph_rounded), 'DELAYED': ('Différé', Icons.schedule_rounded),
    'STALE': ('Ancien', Icons.history_toggle_off_rounded), 'TO_RECONCILE': ('À rapprocher', Icons.compare_arrows_rounded), 'SIMULATED': ('Simulé', Icons.science_outlined),
    'MANUAL_UNVERIFIED': ('Saisie non officielle', Icons.edit_outlined), 'INDICATIVE': ('Indicatif', Icons.info_outline_rounded), 'OFFLINE_CACHE': ('Ancien · hors ligne', Icons.cloud_off_rounded),
    'MIXED_COST_AND_QUOTES': ('Coût + cours', Icons.layers_outlined), 'LEDGER_AT_COST': ('Registre, au coût', Icons.receipt_long_outlined), 'NONE': ('Aucun', Icons.remove_rounded),
  };
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final e = _map[kind] ?? (kind, Icons.label_outline);
    final fg = onDark ? Colors.white.withValues(alpha: .92) : (kind == 'CONFIRMED' ? p.success : kind == 'STALE' || kind == 'TO_RECONCILE' || kind == 'OFFLINE_CACHE' ? p.warning : kind == 'SIMULATED' ? p.info : p.inkMuted);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: onDark ? Colors.white.withValues(alpha: .14) : fg.withValues(alpha: .1), borderRadius: BorderRadius.circular(Radii.pill)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(e.$2, size: 12.5, color: fg), const SizedBox(width: 4), Text(e.$1, style: inter(11.5, w: FontWeight.w600, color: fg))]),
    );
  }
}

class Pill extends StatelessWidget {
  final String text;
  final Color? color;
  final IconData? icon;
  const Pill(this.text, {super.key, this.color, this.icon});
  @override
  Widget build(BuildContext context) {
    final c = color ?? context.pal.inkMuted;
    return Container(padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4), decoration: BoxDecoration(color: c.withValues(alpha: .12), borderRadius: BorderRadius.circular(Radii.pill)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [if (icon != null) ...[Icon(icon, size: 13, color: c), const SizedBox(width: 4)], Text(text, style: inter(12, w: FontWeight.w600, color: c))]));
  }
}

Color stateColor(BuildContext c, String s) {
  final p = c.pal;
  return switch (s) {
    'SUCCEEDED' || 'CONFIRMED' || 'ACTIVE' || 'PAID' || 'OK' || 'APPLIED' || 'RESOLVED' || 'EXECUTED' || 'TARGET_REACHED' || 'RECONCILED' || 'SETTLED' || 'COMMITTED' => p.success,
    'UNKNOWN' || 'FAILED' || 'EXCEEDED' || 'LATE' || 'REJECTED' || 'REVOKED' || 'BLOCKED_OUTBOUND' || 'MISSED' || 'CONFLICT' || 'OPEN' => p.error,
    'WARNING' || 'WAITING' || 'PENDING' || 'PROCESSING' || 'DUE' || 'ELIGIBLE' || 'INVESTIGATING' || 'REVIEW_REQUIRED' || 'PARTIAL' || 'RESERVED' || 'SUBMITTING' || 'AWAITING_CONFIRMATION' => p.warning,
    _ => p.inkMuted,
  };
}
const stateFr = {
  'DRAFT': 'Brouillon', 'AWAITING_CONFIRMATION': 'À confirmer', 'AUTHORIZED': 'Autorisé', 'RESERVED': 'Réservé', 'SUBMITTING': 'Envoi…', 'PROCESSING': 'En cours', 'SUCCEEDED': 'Réussi',
  'FAILED': 'Échoué', 'CANCELLED': 'Annulé', 'UNKNOWN': 'Incertain', 'REFUNDED_AFTER_SUCCESS': 'Remboursé', 'ACTIVE': 'Actif', 'TARGET_REACHED': 'Objectif atteint', 'LATE': 'En retard',
  'RELEASED': 'Débloqué', 'WAITING': 'Délai en cours', 'ELIGIBLE': 'À confirmer', 'EXECUTED': 'Exécuté', 'REJECTED': 'Refusé', 'PLANNED': 'Prévu', 'DUE': 'Dû', 'CONFIRMED': 'Confirmé',
  'MISSED': 'Manqué', 'SCHEDULED': 'Prévu', 'PAID': 'Payé', 'PARTIAL': 'Partiel', 'RESCHEDULED': 'Reporté', 'SETTLED': 'Soldé', 'OPEN': 'Ouvert', 'CLOSED': 'Clôturé',
  'INVESTIGATING': 'En analyse', 'RESOLVED': 'Résolu', 'DISMISSED_WITH_EVIDENCE': 'Classé', 'PENDING': 'En attente', 'REVOKED': 'Révoqué', 'CONSUMED': 'Utilisée', 'EXPIRED': 'Expirée',
  'REVIEW_REQUIRED': 'À valider', 'BLOCKED_OUTBOUND': 'Sorties bloquées', 'UNASSIGNED': 'Hors cycle', 'COMMITTED': 'Comptabilisé', 'PREVIEW_READY': 'À vérifier', 'RECONCILED': 'Rapproché', 'CONFLICT': 'Conflit', 'APPLIED': 'Appliqué', 'OK': 'Dans le budget', 'WARNING': 'Attention', 'EXCEEDED': 'Dépassé',
};
class StatePill extends StatelessWidget {
  final String state;
  const StatePill(this.state, {super.key});
  @override
  Widget build(BuildContext context) => Pill(stateFr[state] ?? state, color: stateColor(context, state));
}

class AppCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? color;
  final Gradient? gradient;
  final double radius;
  const AppCard({super.key, required this.child, this.padding = const EdgeInsets.all(Space.xl), this.onTap, this.color, this.gradient, this.radius = Radii.card});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final box = AnimatedContainer(
      duration: Motion.d(context, Motion.base), padding: padding,
      decoration: BoxDecoration(color: gradient == null ? (color ?? p.surface) : null, gradient: gradient, borderRadius: BorderRadius.circular(radius),
        border: gradient == null ? Border.all(color: p.border.withValues(alpha: .7)) : null,
        boxShadow: [BoxShadow(color: (p.brightness == Brightness.light ? const Color(0xFF16352F) : Colors.black).withValues(alpha: p.brightness == Brightness.light ? .05 : .25), blurRadius: 24, offset: const Offset(0, 10))]),
      child: child);
    return onTap == null ? box : Pressable(onTap: onTap, radius: radius, child: box);
  }
}

class SectionTitle extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget? trailing;
  const SectionTitle(this.title, {super.key, this.subtitle, this.trailing});
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(bottom: Space.m, top: Space.s), child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: sora(17, color: context.pal.ink)), if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(subtitle!, style: inter(13, color: context.pal.inkMuted)))])),
    ?trailing,
  ]));
}

/// État vide élégant, explicite et actionnable (llm §3.4).
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title, message;
  final String? action;
  final VoidCallback? onAction;
  const EmptyState({super.key, required this.icon, required this.title, required this.message, this.action, this.onAction});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(padding: const EdgeInsets.symmetric(vertical: Space.x3, horizontal: Space.xl), child: Column(mainAxisSize: MainAxisSize.min, children: [
      AnimatedProgress(value: 1, builder: (_, v) => Transform.scale(scale: .8 + .2 * v, child: Container(width: 76, height: 76, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [p.accent.withValues(alpha: .55 * v), p.accentSoft.withValues(alpha: .2)])), child: Icon(icon, size: 34, color: p.primary)))),
      const SizedBox(height: Space.l),
      Text(title, textAlign: TextAlign.center, style: sora(18, color: p.ink)),
      const SizedBox(height: Space.s),
      ConstrainedBox(constraints: const BoxConstraints(maxWidth: 380), child: Text(message, textAlign: TextAlign.center, style: inter(14, color: p.inkMuted, height: 1.45))),
      if (action != null) ...[const SizedBox(height: Space.l), FilledButton.icon(onPressed: onAction, icon: const Icon(Icons.add_rounded, size: 20), label: Text(action!))],
    ]));
  }
}

class ErrorState extends StatelessWidget {
  final Object error;
  final VoidCallback? onRetry;
  const ErrorState({super.key, required this.error, this.onRetry});
  @override
  Widget build(BuildContext context) {
    final e = error is ApiError ? error as ApiError : null;
    return EmptyState(icon: e?.offline == true ? Icons.cloud_off_rounded : Icons.error_outline_rounded, title: e?.offline == true ? 'Hors ligne' : 'Impossible de charger', message: e?.message ?? '$error', action: onRetry == null ? null : 'Réessayer', onAction: onRetry);
  }
}

/// Squelette animé (shimmer) pendant le chargement.
class Skeleton extends StatefulWidget {
  final double height, width;
  final double radius;
  const Skeleton({super.key, this.height = 16, this.width = double.infinity, this.radius = 10});
  @override
  State<Skeleton> createState() => _SkeletonState();
}
class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final AnimationController c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat();
  @override
  void dispose() { c.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return AnimatedBuilder(animation: c, builder: (_, _) => Container(height: widget.height, width: widget.width, decoration: BoxDecoration(borderRadius: BorderRadius.circular(widget.radius),
      gradient: LinearGradient(begin: Alignment(-1 + 2 * c.value - .6, 0), end: Alignment(-1 + 2 * c.value + .6, 0), colors: [p.surfaceAlt, p.surfaceAlt.withValues(alpha: .35), p.surfaceAlt]))));
  }
}
class LoadingList extends StatelessWidget {
  final int count;
  const LoadingList({super.key, this.count = 4});
  @override
  Widget build(BuildContext context) => Column(children: [for (var i = 0; i < count; i++) Padding(padding: const EdgeInsets.only(bottom: 12), child: Skeleton(height: i == 0 ? 120 : 64, radius: 18))]);
}

/// Chargement + repli hors ligne + rechargement sur événement temps réel. Aucune donnée fictive.
class Loader<T> extends StatefulWidget {
  final Future<T> Function(AppState app) load;
  final Widget Function(BuildContext, T data, bool stale) builder;
  final Widget? loading;
  /// Écran complet (Scaffold) : rendu direct, badge « ancien » superposé.
  final bool page;
  const Loader({super.key, required this.load, required this.builder, this.loading, this.page = false});
  @override
  State<Loader<T>> createState() => LoaderState<T>();
}
class LoaderState<T> extends State<Loader<T>> {
  T? data;
  Object? error;
  bool stale = false, busy = false;
  int seen = -1;
  Future<void> reload() async {
    final app = context.appRead;
    setState(() => busy = true);
    try { final d = await widget.load(app); if (mounted) setState(() { data = d; error = null; stale = !app.online; }); }
    catch (e) { if (mounted) setState(() { error = e; if (data != null) stale = true; }); }
    finally { if (mounted) setState(() => busy = false); }
  }
  @override
  void didChangeDependencies() { super.didChangeDependencies(); final r = context.app.revision; if (r != seen) { seen = r; reload(); } }
  @override
  Widget build(BuildContext context) {
    if (data != null && widget.page) return Stack(children: [Positioned.fill(child: widget.builder(context, data as T, stale)), if (stale) const Positioned(top: 8, right: 16, child: SafeArea(child: DataLabel('OFFLINE_CACHE')))]);
    if (error != null && data == null && widget.page) return Scaffold(body: SafeArea(child: ErrorState(error: error!, onRetry: reload)));
    if (data != null) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [if (stale) const Padding(padding: EdgeInsets.only(bottom: 8), child: Align(alignment: Alignment.centerLeft, child: DataLabel('OFFLINE_CACHE'))), widget.builder(context, data as T, stale)]);
    if (error != null) return ErrorState(error: error!, onRetry: reload);
    return widget.loading ?? const LoadingList();
  }
}

class AmountField extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final String? helper;
  final bool autofocus;
  const AmountField({super.key, required this.controller, this.label = 'Montant', this.helper, this.autofocus = false});
  @override
  Widget build(BuildContext context) => TextFormField(
    controller: controller, autofocus: autofocus, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d\s]'))],
    style: sora(22, color: context.pal.ink), decoration: InputDecoration(labelText: label, suffixText: 'FCFA', helperText: helper),
    validator: (v) => parseAmountInput(v ?? '') == null ? 'Montant entier positif requis' : null,
  );
}

Widget gap([double h = Space.l]) => SizedBox(height: h, width: h);

void toast(BuildContext context, String msg, {bool error = false}) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Row(children: [Icon(error ? Icons.error_outline_rounded : Icons.check_circle_rounded, color: error ? const Color(0xFFF08A84) : const Color(0xFFA1E6CC), size: 20), const SizedBox(width: 10), Expanded(child: Text(msg))])));
}
String errText(Object e) => e is ApiError ? e.message : '$e';

/// Exécute une action réseau en affichant le résultat ; renvoie null en cas d'erreur.
Future<T?> run<T>(BuildContext context, Future<T> Function() f, {String? success}) async {
  try { final r = await f(); if (context.mounted && success != null) toast(context, success); return r; }
  catch (e) { if (context.mounted) toast(context, errText(e), error: true); return null; }
}

/// Feuille modale adaptée (bottom sheet sur mobile, dialogue latéral sur desktop).
Future<T?> openSheet<T>(BuildContext context, Widget Function(BuildContext) builder, {String? title}) {
  final wide = MediaQuery.sizeOf(context).width >= 900;
  final content = (BuildContext c) => SafeArea(child: Padding(padding: EdgeInsets.fromLTRB(Space.xxl, wide ? Space.xxl : 0, Space.xxl, MediaQuery.viewInsetsOf(c).bottom + Space.xxl), child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
    if (title != null) Padding(padding: const EdgeInsets.only(bottom: Space.l), child: Row(children: [Expanded(child: Text(title, style: sora(21, color: c.pal.ink))), if (wide) IconButton(onPressed: () => Navigator.pop(c), icon: const Icon(Icons.close_rounded), tooltip: 'Fermer')])),
    builder(c),
  ]))));
  if (wide) return showDialog<T>(context: context, builder: (c) => Dialog(insetPadding: const EdgeInsets.all(40), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560, maxHeight: 760), child: content(c))));
  return showModalBottomSheet<T>(context: context, isScrollControlled: true, useSafeArea: true, builder: content);
}

class InfoBanner extends StatelessWidget {
  final String text;
  final IconData icon;
  final Color? color;
  final Widget? action;
  const InfoBanner(this.text, {super.key, this.icon = Icons.info_outline_rounded, this.color, this.action});
  @override
  Widget build(BuildContext context) {
    final c = color ?? context.pal.info;
    return Container(padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: c.withValues(alpha: .09), borderRadius: BorderRadius.circular(14), border: Border.all(color: c.withValues(alpha: .25))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(icon, color: c, size: 20), const SizedBox(width: 10), Expanded(child: Text(text, style: inter(13.5, color: context.pal.ink, height: 1.4))), ?action]));
  }
}

class KeyValue extends StatelessWidget {
  final String k;
  final Widget v;
  const KeyValue(this.k, this.v, {super.key});
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 7), child: Row(children: [Expanded(child: Text(k, style: inter(14, color: context.pal.inkMuted))), v]));
}

/// Barre de progression expressive (dégradé + animation d'entrée).
class ProgressBar extends StatelessWidget {
  final double value;
  final Color? color;
  final double height;
  const ProgressBar(this.value, {super.key, this.color, this.height = 8});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final c = color ?? p.primary;
    return AnimatedProgress(value: value.clamp(0, 1).toDouble(), builder: (_, v) => Container(height: height, decoration: BoxDecoration(color: p.surfaceAlt, borderRadius: BorderRadius.circular(height)),
      child: FractionallySizedBox(alignment: Alignment.centerLeft, widthFactor: v, child: Container(decoration: BoxDecoration(borderRadius: BorderRadius.circular(height), gradient: LinearGradient(colors: [c.withValues(alpha: .75), c]))))));
  }
}

class ListRow extends StatelessWidget {
  final Widget leading;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  const ListRow({super.key, required this.leading, required this.title, this.subtitle, this.trailing, this.onTap});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Pressable(onTap: onTap, child: Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Row(children: [
      leading, const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: inter(15, w: FontWeight.w600, color: p.ink), maxLines: 1, overflow: TextOverflow.ellipsis), if (subtitle != null) Text(subtitle!, style: inter(12.5, color: p.inkMuted), maxLines: 1, overflow: TextOverflow.ellipsis)])),
      if (trailing != null) ...[const SizedBox(width: 8), trailing!],
    ])));
  }
}
class IconBadge extends StatelessWidget {
  final IconData icon;
  final Color? color;
  final double size;
  const IconBadge(this.icon, {super.key, this.color, this.size = 42});
  @override
  Widget build(BuildContext context) { final c = color ?? context.pal.primary; return Container(width: size, height: size, decoration: BoxDecoration(color: c.withValues(alpha: .12), borderRadius: BorderRadius.circular(size * .32)), child: Icon(icon, color: c, size: size * .5)); }
}

/// Bouton d'action vers une confirmation forte (step-up) avec récapitulatif explicite.
Future<bool> confirmDanger(BuildContext context, {required String title, required String message, String confirm = 'Confirmer', bool destructive = false}) async {
  final r = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: Text(title, style: sora(19, color: c.pal.ink)), content: Text(message, style: inter(14.5, color: c.pal.inkSoft, height: 1.45)), actions: [
    TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Annuler')),
    FilledButton(style: destructive ? FilledButton.styleFrom(backgroundColor: c.pal.error, foregroundColor: Colors.white) : null, onPressed: () => Navigator.pop(c, true), child: Text(confirm)),
  ]));
  return r == true;
}
