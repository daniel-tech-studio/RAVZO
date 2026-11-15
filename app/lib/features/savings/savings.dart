import 'dart:async';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/charts.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';

const goalIcons = {'travel': Icons.flight_takeoff_rounded, 'home': Icons.home_rounded, 'car': Icons.two_wheeler_rounded, 'school': Icons.school_rounded, 'health': Icons.health_and_safety_rounded, 'emergency': Icons.shield_rounded, 'gift': Icons.celebration_rounded, 'other': Icons.savings_rounded};
IconData goalIcon(String? k) => goalIcons[k] ?? Icons.savings_rounded;

/// UX07 : coffres en vue analytique.
class SavingsScreen extends StatelessWidget {
  const SavingsScreen({super.key});
  @override
  Widget build(BuildContext context) => PageScaffold(title: 'Épargne', subtitle: 'Coffres, programmes et discipline', fab: FloatingActionButton.extended(onPressed: () => openGoalForm(context), icon: const Icon(Icons.add_rounded), label: const Text('Nouveau coffre')), children: [
    Loader<Map>(load: (a) async => await a.api.get('/savings/goals'), builder: (c, d, _) {
      final goals = d['goals'] as List, t = d['totals'];
      final p = c.pal;
      if (goals.isEmpty) return AppCard(child: EmptyState(icon: Icons.savings_rounded, title: 'Votre premier coffre', message: 'Un coffre a toujours une cible, une échéance et un programme de versements (calendaire ou lié à vos revenus). Les versements sont suggérés, jamais prélevés automatiquement.', action: 'Créer un coffre', onAction: () => openGoalForm(c)));
      final confirmed = goals.fold<int>(0, (s, g) => s + (g['stats']['confirmedCount'] as int));
      final missed = goals.fold<int>(0, (s, g) => s + (g['stats']['missedCount'] as int));
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        AppCard(gradient: p.heroGradient, radius: Radii.hero, child: Row(children: [
          Ring(value: (t['progressPercent'] as num) / 100, size: 112, stroke: 11, color: p.accent, child: Column(mainAxisSize: MainAxisSize.min, children: [Text('${(t['progressPercent'] as num).round()}%', style: sora(24, w: FontWeight.w700, color: Colors.white)), Text('global', style: inter(11.5, color: Colors.white70))])),
          const SizedBox(width: 22),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Épargné', style: inter(13.5, color: Colors.white70)), Money(t['savedMinor'], size: 28, display: true, color: Colors.white),
            Text('sur ${money(t['targetMinor'], hidden: c.app.hideAmounts)}', style: inter(13.5, color: Colors.white70)),
            gap(10), Wrap(spacing: 8, runSpacing: 6, children: [_chip('$confirmed versements confirmés'), if (missed > 0) _chip('$missed manqués'), if (t['lateCount'] > 0) _chip('${t['lateCount']} en retard')]),
          ])),
        ])),
        gap(12),
        InfoBanner('Discipline indicative : vos fonds ne sont pas immobilisés techniquement. RAVZO refuse ses propres sorties hors règles (72 h, 20 %/30 j) mais ne peut empêcher un retrait direct chez votre banque ou opérateur.', icon: Icons.shield_outlined, color: p.copper),
        gap(),
        LayoutBuilder(builder: (c, cons) {
          final cols = cons.maxWidth > 900 ? 3 : cons.maxWidth > 560 ? 2 : 1;
          final w = (cons.maxWidth - (cols - 1) * 14) / cols;
          return Wrap(spacing: 14, runSpacing: 14, children: [for (var i = 0; i < goals.length; i++) SizedBox(width: w, child: Enter(index: i, child: _GoalCard(g: goals[i])))]);
        }),
        gap(),
        AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SectionTitle('Répartition de l’épargne'),
          Donut(size: 170, slices: [for (var i = 0; i < goals.length; i++) DonutSlice(goals[i]['name'], big(goals[i]['savedMinor']).toDouble(), [p.primary, p.copper, p.info, p.accent, p.warning][i % 5])], center: Money(t['savedMinor'], size: 13, compact: true)),
        ])),
      ]);
    }),
  ]);
  static Widget _chip(String t) => Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5), decoration: BoxDecoration(color: Colors.white.withValues(alpha: .14), borderRadius: BorderRadius.circular(99)), child: Text(t, style: inter(12, w: FontWeight.w600, color: Colors.white)));
}

class _GoalCard extends StatelessWidget {
  final Map g;
  const _GoalCard({required this.g});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final late = g['status'] == 'LATE';
    return AppCard(onTap: () => context.go('/savings/${g['id']}'), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [IconBadge(goalIcon(g['icon']), color: late ? p.warning : p.primary), const Spacer(), StatePill(g['status'])]),
      gap(12), Text(g['name'], style: sora(17, color: p.ink)),
      gap(4), Row(children: [Money(g['savedMinor'], size: 16), Text('  /  ', style: inter(13, color: p.inkMuted)), Money(g['targetMinor'], size: 13, color: p.inkMuted, weight: FontWeight.w500)]),
      gap(10), ProgressBar((g['progressPercent'] as num) / 100, color: late ? p.warning : null, height: 10),
      gap(8), Text(g['daysLeft'] >= 0 ? 'Échéance ${fmtDate(g['deadline'])} · ${g['daysLeft']} j' : 'Échéance dépassée de ${-g['daysLeft']} j', style: inter(12.5, color: late ? p.warning : p.inkMuted)),
      if (g['onTrack'] == false && !late) Padding(padding: const EdgeInsets.only(top: 6), child: Pill('En dessous du programme', color: p.copper, icon: Icons.trending_down_rounded)),
    ]));
  }
}

Future<void> openGoalForm(BuildContext context, {Map? existing}) {
  final name = TextEditingController(text: existing?['name']), target = TextEditingController(text: existing?['targetMinor']), amount = TextEditingController(text: existing?['plan']?['amountRule']?.toString().split(':').last);
  var icon = existing?['icon'] ?? 'other';
  var trigger = existing?['plan']?['triggerType'] ?? 'CALENDAR';
  var day = 5.0, percent = 10.0;
  DateTime deadline = existing == null ? DateTime.now().add(const Duration(days: 180)) : DateTime.parse(existing['deadline']);
  final form = GlobalKey<FormState>();
  return openSheet(context, title: existing == null ? 'Nouveau coffre' : 'Replanifier', (c) => StatefulBuilder(builder: (c, set) => Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    Wrap(spacing: 8, runSpacing: 8, children: [for (final e in goalIcons.entries) ChoiceChip(label: Icon(e.value, size: 20), selected: icon == e.key, onSelected: (_) => set(() => icon = e.key))]),
    gap(12), TextFormField(controller: name, decoration: const InputDecoration(labelText: 'Nom du coffre'), validator: (v) => (v ?? '').trim().isEmpty ? 'Nom requis' : null),
    gap(12), AmountField(controller: target, label: 'Montant cible'),
    ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.flag_rounded), title: Text('Échéance : ${fmtDate(isoDate(deadline))}'), onTap: () async { final d = await showDatePicker(context: c, initialDate: deadline, firstDate: DateTime.now().add(const Duration(days: 1)), lastDate: DateTime.now().add(const Duration(days: 3650))); if (d != null) set(() => deadline = d); }),
    Text('Programme de versements (obligatoire)', style: inter(14, w: FontWeight.w600, color: c.pal.ink)),
    gap(8), SegmentedButton(segments: const [ButtonSegment(value: 'CALENDAR', label: Text('Calendaire'), icon: Icon(Icons.calendar_month_rounded)), ButtonSegment(value: 'INCOME_TRIGGER', label: Text('À chaque revenu'), icon: Icon(Icons.south_west_rounded))], selected: {trigger}, onSelectionChanged: (s) => set(() => trigger = s.first)),
    gap(12),
    if (trigger == 'CALENDAR') ...[AmountField(controller: amount, label: 'Versement mensuel suggéré'), gap(8), Text('Le ${day.round()} de chaque mois', style: inter(13.5, color: c.pal.inkSoft)), Slider(value: day, min: 1, max: 28, divisions: 27, onChanged: (v) => set(() => day = v))]
    else ...[Text('${percent.round()} % de chaque revenu', style: inter(14, color: c.pal.ink)), Slider(value: percent, min: 1, max: 50, divisions: 49, onChanged: (v) => set(() => percent = v))],
    gap(6), Text('Les versements sont proposés, jamais exécutés automatiquement. À l’échéance, le coffre et sa protection sont conservés.', style: inter(12.5, color: c.pal.inkMuted)),
    gap(14),
    FilledButton(onPressed: () async {
      if (!form.currentState!.validate()) return;
      final plan = trigger == 'CALENDAR' ? {'triggerType': 'CALENDAR', 'amountRule': 'FIXED:${parseAmountInput(amount.text) ?? '0'}', 'scheduleRule': 'MONTHLY:${day.round()}'} : {'triggerType': 'INCOME_TRIGGER', 'amountRule': 'PERCENT:${percent.round() * 100}'};
      final api = c.appRead.api;
      final r = await run(c, () => existing == null
        ? api.post('/savings/goals', {'name': name.text.trim(), 'icon': icon, 'targetMinor': parseAmountInput(target.text), 'deadline': isoDate(deadline), 'plan': plan})
        : api.patch('/savings/goals/${existing['id']}', {'name': name.text.trim(), 'icon': icon, 'targetMinor': parseAmountInput(target.text), 'deadline': isoDate(deadline), 'plan': plan, 'expectedVersion': existing['version']}), success: existing == null ? 'Coffre créé' : 'Coffre replanifié');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: Text(existing == null ? 'Créer le coffre' : 'Enregistrer')),
  ]))));
}

Future<void> openQuickContribution(BuildContext context) async {
  final d = await context.appRead.api.get('/savings/goals');
  if (!context.mounted) return;
  final goals = (d['goals'] as List).where((g) => g['status'] != 'RELEASED').toList();
  if (goals.isEmpty) { openGoalForm(context); return; }
  await openSheet(context, title: 'Épargner', (c) => Column(children: [for (final g in goals) ListRow(leading: IconBadge(goalIcon(g['icon'])), title: g['name'], subtitle: '${(g['progressPercent'] as num).round()} % · reste ${money(g['remainingMinor'], hidden: c.app.hideAmounts)}', trailing: const Icon(Icons.chevron_right_rounded), onTap: () { Navigator.pop(c); openContribution(context, g); })]));
}

Future<void> openContribution(BuildContext context, Map g, {Map? planned}) async {
  final app = context.appRead;
  final prep = await app.api.post('/savings/goals/${g['id']}/contributions/prepare');
  if (!context.mounted) return;
  final amount = TextEditingController(text: planned?['plannedMinor'] ?? prep['suggestedMinor']);
  await openSheet(context, title: 'Versement — ${g['name']}', (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    AmountField(controller: amount, autofocus: true, helper: 'Suggestion du programme, modifiable'),
    if (prep['catchUpSuggestion'] != null) ...[gap(10), InfoBanner('Rattrapage proposé (non imposé) : +${money(prep['catchUpSuggestion']['perContributionExtraMinor'], hidden: c.app.hideAmounts)} sur les ${prep['catchUpSuggestion']['over']} prochains versements.', icon: Icons.trending_up_rounded)],
    gap(10), Text('Affectation de votre portefeuille courant vers ce coffre. Votre patrimoine total ne change pas.', style: inter(12.5, color: c.pal.inkMuted)),
    gap(14), FilledButton(onPressed: () async {
      final r = await run(c, () => app.api.post('/savings/goals/${g['id']}/contributions/${planned?['id'] ?? 'manual'}/confirm', {'amountMinor': parseAmountInput(amount.text)}, true), success: 'Versement confirmé');
      if (r != null && c.mounted) { Navigator.pop(c); app.bump(); if (r['status'] == 'TARGET_REACHED') toast(c, 'Objectif atteint ! Le coffre reste protégé.'); }
    }, child: const Text('Confirmer le versement')),
  ]));
}

/// UX08 : détail hybride — résumé et actions visibles, le reste en onglets.
class GoalDetailScreen extends StatelessWidget {
  final String id;
  const GoalDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<List>(load: (a) async => [await a.api.get('/savings/goals/$id'), await a.api.get('/savings/goals/$id/withdrawal-capacity')], page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, d, _) {
    final g = d[0] as Map, cap = d[1] as Map;
    final p = c.pal;
    final contribs = (g['contributions'] as List);
    final confirmed = contribs.where((x) => x['state'] == 'CONFIRMED').toList()..sort((a, b) => (a['confirmedAt'] ?? '').compareTo(b['confirmedAt'] ?? ''));
    var cum = BigInt.zero;
    final series = [for (final x in confirmed) () { cum += big(x['confirmedMinor']); return ChartPoint(fmtDay(x['confirmedAt']), cum.toDouble(), raw: cum.toString()); }()];
    return DefaultTabController(length: 3, child: PageScaffold(title: g['name'], subtitle: 'Échéance ${fmtDate(g['deadline'])}', back: true, actions: [IconButton(tooltip: 'Replanifier', onPressed: () => openGoalForm(c, existing: g), icon: const Icon(Icons.edit_calendar_rounded))], children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Ring(value: (g['progressPercent'] as num) / 100, size: 120, stroke: 12, color: g['status'] == 'LATE' ? p.warning : null, child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(goalIcon(g['icon']), color: p.primary), Text('${(g['progressPercent'] as num).round()}%', style: sora(20, color: p.ink))])),
          const SizedBox(width: 20),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [StatePill(g['status']), gap(6), Money(g['savedMinor'], size: 28, display: true), Text('sur ${money(g['targetMinor'], hidden: c.app.hideAmounts)} · reste ${money(g['remainingMinor'], hidden: c.app.hideAmounts)}', style: inter(13.5, color: p.inkMuted)), gap(6), Pill(g['protection']['mode'] == 'ADVISORY' ? 'Protection indicative' : 'Protection effective', color: p.copper, icon: Icons.shield_outlined)])),
        ]),
        gap(),
        Row(children: [
          Expanded(child: FilledButton.icon(onPressed: g['status'] == 'RELEASED' ? null : () => openContribution(c, g), icon: const Icon(Icons.add_rounded), label: const Text('Verser'))),
          const SizedBox(width: 10),
          Expanded(child: OutlinedButton.icon(onPressed: big(g['savedMinor']) == BigInt.zero ? null : () => _withdraw(c, g, cap), icon: const Icon(Icons.lock_open_rounded), label: const Text('Demander un retrait'))),
        ]),
        if (g['status'] == 'LATE') ...[gap(12), InfoBanner('Échéance dépassée : le coffre et sa protection sont conservés. Vous pouvez proposer une nouvelle échéance.', color: p.warning, icon: Icons.schedule_rounded, action: TextButton(onPressed: () => openGoalForm(c, existing: g), child: const Text('Replanifier')))],
      ])),
      gap(),
      const TabBar(tabs: [Tab(text: 'Programme'), Tab(text: 'Historique'), Tab(text: 'Retraits')]),
      SizedBox(height: 560, child: TabBarView(children: [
        ListView(padding: const EdgeInsets.only(top: 12), children: [
          AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(g['plan']['triggerType'] == 'CALENDAR' ? 'Versement de ${money(g['plan']['amountRule'].toString().split(':').last, hidden: c.app.hideAmounts)} le ${g['plan']['scheduleRule'].toString().split(':').last} de chaque mois' : '${int.parse(g['plan']['amountRule'].toString().split(':').last) / 100} % de chaque revenu', style: inter(14.5, w: FontWeight.w600, color: p.ink)),
            gap(8),
            for (final x in contribs.where((x) => ['PLANNED', 'DUE', 'MISSED'].contains(x['state'])).take(8)) ListRow(leading: IconBadge(Icons.event_rounded, size: 34, color: stateColor(c, x['state'])), title: fmtDate(x['dueAt']), subtitle: x['kind'] == 'INCOME' ? 'Lié à un revenu' : null, trailing: Row(mainAxisSize: MainAxisSize.min, children: [Money(x['plannedMinor'], size: 13.5), const SizedBox(width: 8), StatePill(x['state']), if (x['state'] != 'PLANNED') TextButton(onPressed: () => openContribution(c, g, planned: x), child: const Text('Verser'))])),
          ])),
        ]),
        ListView(padding: const EdgeInsets.only(top: 12), children: [
          if (series.length > 1) AppCard(child: AreaChart(height: 180, series: [ChartSeries('Épargne cumulée', series, p.primary)])),
          gap(12),
          AppCard(child: Column(children: [if (confirmed.isEmpty) Text('Aucun versement confirmé.', style: inter(14, color: p.inkMuted)), for (final x in confirmed.reversed) KeyValue(fmtDateTime(x['confirmedAt']), Money(x['confirmedMinor'], signed: true, colorize: true))])),
        ]),
        ListView(padding: const EdgeInsets.only(top: 12), children: [
          AppCard(child: Column(children: [
            KeyValue('Base reconstituée (30 j)', Money(cap['baseMinor'])), KeyValue('Retraits exceptionnels exécutés', Money(cap['executedInWindowMinor'])), KeyValue('Demandes réservées', Money(cap['reservedMinor'])),
            if (cap['excludedRecentContributionsMinor'] != '0') KeyValue('Versements < 72 h exclus', Money(cap['excludedRecentContributionsMinor'])),
            KeyValue('Capacité exceptionnelle (20 %)', Money(cap['capacityMinor'], weight: FontWeight.w700)), KeyValue('Retrait ordinaire', Text(cap['ordinaryAvailable'] ? 'Possible (objectif atteint)' : 'Après l’objectif atteint')),
          ])),
          gap(12),
          for (final w in (g['withdrawals'] as List)) Padding(padding: const EdgeInsets.only(bottom: 10), child: _WithdrawalCard(w: w)),
        ]),
      ])),
    ]));
  });
  void _withdraw(BuildContext c, Map g, Map cap) {
    var kind = cap['ordinaryAvailable'] == true ? 'ORDINARY' : 'EXCEPTIONAL';
    final amount = TextEditingController(text: kind == 'ORDINARY' ? cap['ordinaryMaxMinor'] : cap['capacityMinor']);
    final reason = TextEditingController();
    openSheet(c, title: 'Demande de retrait', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SegmentedButton(segments: [ButtonSegment(value: 'ORDINARY', label: const Text('Ordinaire'), enabled: cap['ordinaryAvailable'] == true), const ButtonSegment(value: 'EXCEPTIONAL', label: Text('Exceptionnel'))], selected: {kind}, onSelectionChanged: (x) => set(() { kind = x.first; amount.text = kind == 'ORDINARY' ? cap['ordinaryMaxMinor'] : cap['capacityMinor']; })),
      gap(12), InfoBanner(kind == 'ORDINARY' ? 'Objectif atteint : aucune libération automatique. Le retrait sera confirmable dans 72 heures.' : 'Maximum ${money(cap['capacityMinor'], hidden: s.app.hideAmounts)} (20 % d’une base reconstituée sur 30 jours glissants). Confirmable après 72 heures, réévalué à l’échéance.', icon: Icons.hourglass_top_rounded),
      if (kind == 'EXCEPTIONAL' && cap['excludedRecentContributionsMinor'] != '0') ...[gap(8), InfoBanner('${money(cap['excludedRecentContributionsMinor'], hidden: s.app.hideAmounts)} versés il y a moins de 72 h sont exclus de la base (protection contre le dépôt-puis-retrait).', icon: Icons.info_outline_rounded, color: s.pal.copper)],
      gap(12), AmountField(controller: amount),
      gap(12), TextField(controller: reason, decoration: const InputDecoration(labelText: 'Motif (facultatif)')),
      gap(14), FilledButton.icon(onPressed: () async {
        final app = s.appRead;
        final a = parseAmountInput(amount.text);
        if (a == null) return;
        final r = await run(s, () async => app.api.post('/savings/goals/${g['id']}/withdrawal-requests', {'kind': kind, 'amountMinor': a, if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim(), 'approval': await app.approve('savings.withdrawal.request', {'goalId': g['id'], 'kind': kind, 'amountMinor': a})}), success: 'Demande enregistrée — délai de 72 h');
        if (r != null && s.mounted) { Navigator.pop(s); app.bump(); }
      }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Demander (validation forte)')),
    ])));
  }
}

class _WithdrawalCard extends StatefulWidget {
  final Map w;
  const _WithdrawalCard({required this.w});
  @override
  State<_WithdrawalCard> createState() => _WithdrawalCardState();
}
class _WithdrawalCardState extends State<_WithdrawalCard> {
  Timer? t;
  @override
  void initState() { super.initState(); t = Timer.periodic(const Duration(seconds: 30), (_) => setState(() {})); }
  @override
  void dispose() { t?.cancel(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final w = widget.w;
    final p = context.pal;
    final eligible = DateTime.parse(w['eligibleAt']);
    final serverNow = context.app.api.lastServerTime ?? DateTime.now().toUtc();
    final remaining = eligible.difference(serverNow);
    final waiting = ['WAITING', 'ELIGIBLE'].contains(w['status']);
    final total = const Duration(hours: 72).inSeconds;
    return AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Text(w['kind'] == 'EXCEPTIONAL' ? 'Retrait exceptionnel' : 'Retrait ordinaire', style: inter(15, w: FontWeight.w600, color: p.ink)), const Spacer(), StatePill(remaining.isNegative && w['status'] == 'WAITING' ? 'ELIGIBLE' : w['status'])]),
      gap(6), Money(w['requestedMinor'], size: 20, display: true),
      Text('Demandé ${fmtDateTime(w['requestedAt'])}', style: inter(12.5, color: p.inkMuted)),
      if (waiting) ...[
        gap(10), ProgressBar(1 - (remaining.inSeconds.clamp(0, total) / total), color: p.copper),
        gap(6), Text(remaining.isNegative ? 'Délai écoulé : confirmation explicite requise' : 'Confirmable dans ${countdown(remaining)} (horloge serveur)', style: inter(13, w: FontWeight.w600, color: remaining.isNegative ? p.success : p.inkSoft)),
        gap(10), Row(children: [
          Expanded(child: OutlinedButton(onPressed: () async { await run(context, () => context.appRead.api.post('/savings/withdrawal-requests/${w['id']}/cancel'), success: 'Demande annulée'); if (context.mounted) context.appRead.bump(); }, child: const Text('Annuler'))),
          const SizedBox(width: 10),
          Expanded(child: FilledButton(onPressed: remaining.isNegative ? () async { final app = context.appRead; await run(context, () async => app.api.post('/savings/withdrawal-requests/${w['id']}/confirm', {'approval': await app.approve('savings.withdrawal.confirm', {'requestId': w['id']})}), success: 'Retrait effectué vers le courant'); app.bump(); } : null, child: const Text('Confirmer'))),
        ]),
      ],
    ]));
  }
}
