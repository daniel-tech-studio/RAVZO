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
import 'money.dart';

/// UX09 : budgets analytiques par cycle de revenu (graphiques, catégories, prévisions, alertes non bloquantes).
class BudgetsTab extends StatelessWidget {
  const BudgetsTab({super.key});
  @override
  Widget build(BuildContext context) => TabBody(children: [Loader<Map>(load: (a) async => await a.api.get('/budgets/analytics'), builder: (c, b, _) => b['cycle'] == null ? _NoCycle() : CycleBody(b: b))]);
}
class _NoCycle extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Column(children: [
    AppCard(child: EmptyState(icon: Icons.donut_large_rounded, title: 'Aucun cycle budgétaire ouvert', message: 'Vos budgets suivent vos cycles de revenu, pas forcément le mois calendaire. Ouvrez un cycle quand vous recevez votre revenu ; il se clôturera automatiquement à la date prévue.', action: 'Ouvrir un cycle', onAction: () => openCycleForm(context))),
    gap(), Loader<List>(load: (a) async => await a.api.get('/budget-cycles') as List, builder: (c, cs, _) => cs.isEmpty ? const SizedBox() : AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Cycles précédents'), for (final cy in cs) ListRow(leading: const IconBadge(Icons.history_rounded, size: 36), title: cy['label'], subtitle: '${fmtDate(cy['startsAt'])} → ${fmtDate(cy['plannedEndAt'])}', trailing: StatePill(cy['state']), onTap: () => c.push('/money/budgets/cycles/${cy['id']}'))]))),
  ]);
}
Future<void> openCycleForm(BuildContext context) {
  final label = TextEditingController();
  var days = 30.0;
  var copy = true;
  return openSheet(context, title: 'Ouvrir un cycle', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    TextField(controller: label, decoration: const InputDecoration(labelText: 'Nom (facultatif)', hintText: 'ex. Salaire de novembre')),
    gap(14), Text('Durée suggérée : ${days.round()} jours', style: inter(14, w: FontWeight.w600, color: c.pal.ink)),
    Slider(value: days, min: 7, max: 62, divisions: 55, label: '${days.round()} j', onChanged: (v) => set(() => days = v)),
    SwitchListTile(contentPadding: EdgeInsets.zero, value: copy, onChanged: (v) => set(() => copy = v), title: const Text('Reprendre les budgets du cycle précédent')),
    gap(8), FilledButton(onPressed: () async {
      final r = await run(c, () => c.appRead.api.post('/budget-cycles', {if (label.text.trim().isNotEmpty) 'label': label.text.trim(), 'durationDays': days.round(), 'copyBudgetsFromPrevious': copy}), success: 'Cycle ouvert');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: const Text('Ouvrir le cycle')),
  ])));
}

class CycleBody extends StatelessWidget {
  final Map b;
  const CycleBody({super.key, required this.b});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final cy = b['cycle'], t = b['totals'];
    final open = cy['state'] == 'OPEN';
    final daily = b['daily'] as List;
    final cats = b['categories'] as List;
    final colors = [p.primary, p.copper, p.info, p.accent, p.warning, p.error, p.neutral];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(cy['label'], style: sora(18, color: p.ink)), Text('${fmtDate(cy['startsAt'])} → ${fmtDate(cy['plannedEndAt'])} · jour ${cy['elapsedDays']}/${cy['totalDays']}', style: inter(13, color: p.inkMuted))])), StatePill(cy['state'])]),
        gap(),
        Wrap(spacing: 28, runSpacing: 12, children: [
          _Stat('Dépensé', t['spentMinor'], 'TRACKED'), _Stat('Prévu', t['plannedMinor'], 'FORECAST'), _Stat('Revenus du cycle', t['incomeMinor'], 'TRACKED'), if (open) _Stat('Projection fin de cycle', t['forecastSpentMinor'], 'FORECAST'),
        ]),
        gap(),
        if (daily.length > 1) AreaChart(height: 170, series: [
          ChartSeries('Dépenses cumulées', [for (final x in daily) ChartPoint(fmtDay(x['date']), big(x['cumulativeSpentMinor']).toDouble(), forecast: x['kind'] == 'FORECAST', raw: x['cumulativeSpentMinor'])], p.primary),
          ChartSeries('Budget total', [for (final x in daily) ChartPoint(fmtDay(x['date']), big(t['plannedMinor']).toDouble(), raw: t['plannedMinor'])], p.copper, fill: false),
        ]),
        if (open) Row(children: [TextButton.icon(onPressed: () => openBudgetForm(context, cy['id']), icon: const Icon(Icons.add_rounded), label: const Text('Budget')), const Spacer(), TextButton(onPressed: () async { if (await confirmDanger(context, title: 'Clôturer le cycle ?', message: 'Les chiffres seront figés définitivement. Les opérations suivantes seront « hors cycle » jusqu’à l’ouverture du prochain.')) { if (context.mounted) await run(context, () => context.appRead.api.post('/budget-cycles/${cy['id']}/close'), success: 'Cycle clôturé'); if (context.mounted) context.appRead.bump(); } }, child: const Text('Clôturer maintenant'))]),
      ])),
      gap(),
      if (cats.isNotEmpty) LayoutBuilder(builder: (c, cons) {
        final donut = Donut(size: 180, slices: [for (var i = 0; i < cats.length; i++) DonutSlice(cats[i]['categoryName'] ?? '—', big(cats[i]['spentMinor']).toDouble(), colors[i % colors.length], raw: cats[i]['spentMinor'])], center: Column(mainAxisSize: MainAxisSize.min, children: [Text('Dépensé', style: inter(12, color: p.inkMuted)), Money(t['spentMinor'], size: 14, compact: true)]));
        final bars = Column(children: [for (final x in cats) Padding(padding: const EdgeInsets.only(bottom: 14), child: Pressable(onTap: open ? () => openBudgetForm(context, cy['id'], existing: x) : null, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          CompareBar(label: '${x['categoryName']}${x['essential'] == true ? ' · essentiel' : ''}', plannedMinor: x['plannedMinor'], actualMinor: x['spentMinor'], status: x['status'], forecastMinor: open ? x['forecastMinor'] : null),
          const SizedBox(height: 3), Row(children: [Money(x['spentMinor'], size: 12.5, weight: FontWeight.w500), Text(' / ', style: inter(12.5, color: p.inkMuted)), Money(x['plannedMinor'], size: 12.5, weight: FontWeight.w500, color: p.inkMuted), const Spacer(), if (x['status'] != 'OK') StatePill(x['status'])]),
        ])))]);
        return AppCard(child: cons.maxWidth > 700 ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [donut, const SizedBox(width: 28), Expanded(child: bars)]) : Column(children: [donut, gap(), bars]));
      }) else if (open) AppCard(child: EmptyState(icon: Icons.category_outlined, title: 'Aucun budget dans ce cycle', message: 'Définissez un montant par catégorie. Les dépassements vous alertent sans jamais bloquer un paiement.', action: 'Ajouter un budget', onAction: () => openBudgetForm(context, cy['id']))),
      if ((b['unbudgeted'] as List).isNotEmpty) ...[gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Hors budget'), for (final u in b['unbudgeted']) KeyValue(u['categoryName'] ?? '—', Money(u['spentMinor']))]))],
    ]);
  }
}
class _Stat extends StatelessWidget {
  final String label; final String? minor; final String tag;
  const _Stat(this.label, this.minor, this.tag);
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label, style: inter(12.5, color: context.pal.inkMuted)), Money(minor, size: 19, display: true), DataLabel(tag)]);
}

Future<void> openBudgetForm(BuildContext context, String cycleId, {Map? existing}) async {
  final cats = await fetchCategories(context.appRead, 'EXPENSE');
  if (!context.mounted) return;
  String? cat = existing?['categoryId'];
  final amount = TextEditingController(text: existing?['plannedMinor'] ?? '');
  var threshold = (existing?['alertThreshold'] ?? 80).toDouble();
  bool? essential = existing?['essential'];
  await openSheet(context, title: existing == null ? 'Nouveau budget' : 'Modifier le budget', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (existing == null) categoryPicker(cats, cat, (v) => set(() => cat = v)),
    gap(12), AmountField(controller: amount, label: 'Montant prévu'),
    gap(12), Text('Alerte à ${threshold.round()} %', style: inter(14, color: c.pal.ink)), Slider(value: threshold, min: 50, max: 100, divisions: 10, onChanged: (v) => set(() => threshold = v)),
    SwitchListTile(contentPadding: EdgeInsets.zero, value: essential ?? false, onChanged: (v) => set(() => essential = v), title: const Text('Dépense essentielle'), subtitle: const Text('Réservée dans le disponible conseillé')),
    gap(8), FilledButton(onPressed: () async {
      final api = c.appRead.api;
      final r = await run(c, () => existing == null
        ? api.post('/budgets', {'cycleId': cycleId, 'categoryId': cat, 'plannedMinor': parseAmountInput(amount.text) ?? '0', 'alertThreshold': threshold.round(), 'essential': essential ?? false})
        : api.patch('/budgets/${existing['budgetId']}', {'plannedMinor': parseAmountInput(amount.text) ?? '0', 'alertThreshold': threshold.round(), 'essential': essential ?? false, 'expectedVersion': existing['version']}), success: 'Budget enregistré');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: const Text('Enregistrer')),
  ])));
}

class CycleScreen extends StatelessWidget {
  final String id;
  const CycleScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => PageScaffold(title: 'Cycle budgétaire', back: true, children: [Loader<Map>(load: (a) async => await a.api.get('/budgets/analytics', query: {'cycleId': id}), builder: (c, b, _) => CycleBody(b: b))]);
}

class OffCycleScreen extends StatelessWidget {
  const OffCycleScreen({super.key});
  @override
  Widget build(BuildContext context) => PageScaffold(title: 'Opérations hors cycle', subtitle: 'Rattachement au cycle ouvert sur votre approbation — un cycle clôturé n’est jamais réécrit', back: true, children: [
    Loader<List>(load: (a) async => [await a.api.get('/budget-cycles/off-cycle'), await a.api.get('/budget-cycles/current')], builder: (c, d, _) {
      final items = d[0] as Map; final cycle = d[1];
      final exps = items['expenses'] as List, incs = items['incomes'] as List;
      if (exps.isEmpty && incs.isEmpty) return const AppCard(child: EmptyState(icon: Icons.task_alt_rounded, title: 'Rien à rattacher', message: 'Toutes vos opérations appartiennent à un cycle.'));
      return _OffCycleList(exps: exps, incs: incs, cycle: cycle);
    }),
  ]);
}
class _OffCycleList extends StatefulWidget {
  final List exps, incs; final Map? cycle;
  const _OffCycleList({required this.exps, required this.incs, this.cycle});
  @override
  State<_OffCycleList> createState() => _OffCycleListState();
}
class _OffCycleListState extends State<_OffCycleList> {
  final sel = <String>{};
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (widget.cycle == null) const InfoBanner('Ouvrez un cycle pour pouvoir y rattacher ces opérations.'),
    AppCard(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Column(children: [
      for (final e in widget.exps) CheckboxListTile(value: sel.contains(e['id']), onChanged: widget.cycle == null ? null : (v) => setState(() => v! ? sel.add(e['id']) : sel.remove(e['id'])), title: Text(e['label']), subtitle: Text(fmtDate(e['economicDate'])), secondary: Money('-${e['amountMinor']}', colorize: true)),
      for (final i in widget.incs) CheckboxListTile(value: sel.contains(i['id']), onChanged: widget.cycle == null ? null : (v) => setState(() => v! ? sel.add(i['id']) : sel.remove(i['id'])), title: Text(i['source']), subtitle: Text(fmtDate(i['economicDate'])), secondary: Money(i['grossMinor'], signed: true, colorize: true)),
    ])),
    gap(),
    FilledButton(onPressed: sel.isEmpty || widget.cycle == null ? null : () async {
      final r = await run(context, () => context.appRead.api.post('/budget-cycles/${widget.cycle!['id']}/off-cycle-assignments', {'expenseIds': widget.exps.where((e) => sel.contains(e['id'])).map((e) => e['id']).toList(), 'incomeIds': widget.incs.where((e) => sel.contains(e['id'])).map((e) => e['id']).toList()}), success: 'Rattachement effectué');
      if (r != null && mounted) context.appRead.bump();
    }, child: Text('Rattacher ${sel.length} opération(s) au cycle ouvert')),
  ]);
}

// ─── Charges récurrentes : prévisions, jamais de paiement automatique ───
class ObligationsTab extends StatelessWidget {
  const ObligationsTab({super.key});
  @override
  Widget build(BuildContext context) => TabBody(children: [
    SectionTitle('Charges récurrentes', subtitle: 'Prévues et rappelées ; le paiement exige toujours votre confirmation', trailing: TextButton.icon(onPressed: () => _form(context), icon: const Icon(Icons.add_rounded), label: const Text('Ajouter'))),
    Loader<List>(load: (a) async => await a.api.get('/recurring-obligations') as List, builder: (c, obs, _) => obs.isEmpty ? AppCard(child: EmptyState(icon: Icons.event_repeat_rounded, title: 'Aucune charge', message: 'Loyer, électricité, scolarité, abonnements… Ajoutez-les pour les réserver dans le disponible conseillé.', action: 'Ajouter une charge', onAction: () => _form(c))) : Column(children: [
      for (final o in obs) Padding(padding: const EdgeInsets.only(bottom: 12), child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [IconBadge(Icons.event_repeat_rounded, color: o['active'] ? c.pal.primary : c.pal.inkMuted), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(o['label'], style: inter(15.5, w: FontWeight.w600, color: c.pal.ink)), Text(_rule(o['scheduleRule']), style: inter(12.5, color: c.pal.inkMuted))])), Money(o['amountMinor']),
          PopupMenuButton<String>(onSelected: (v) async { await run(c, () => c.appRead.api.patch('/recurring-obligations/${o['id']}', {'active': v == 'on'})); c.appRead.bump(); }, itemBuilder: (_) => [PopupMenuItem(value: o['active'] ? 'off' : 'on', child: Text(o['active'] ? 'Suspendre' : 'Réactiver'))])]),
        for (final oc in (o['occurrences'] as List).where((x) => x['state'] != 'SKIPPED').take(3)) Padding(padding: const EdgeInsets.only(top: 8), child: Row(children: [
          Text(fmtDate(oc['dueDate']), style: inter(13.5, color: c.pal.inkSoft)), const SizedBox(width: 8), StatePill(oc['state'] == 'FORECAST' ? 'PLANNED' : oc['state']), const Spacer(),
          if (oc['state'] == 'DUE' || oc['state'] == 'FORECAST') ...[
            TextButton(onPressed: () => openExpenseForm(c, occurrenceId: oc['id'], presetLabel: o['label'], presetAmount: oc['expectedMinor']), child: const Text('Marquer payée')),
            IconButton(tooltip: 'Ignorer cette échéance', onPressed: () async { await run(c, () => c.appRead.api.post('/recurring-obligations/occurrences/${oc['id']}/skip')); c.appRead.bump(); }, icon: const Icon(Icons.skip_next_rounded, size: 20)),
          ],
        ])),
      ]))),
    ])),
  ]);
  static String _rule(String r) { final p = r.split(':'); return switch (p[0]) { 'MONTHLY' => 'Chaque mois, le ${p[1]}', 'WEEKLY' => 'Chaque semaine (${['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'][int.parse(p[1]) - 1]}.)', _ => 'Tous les ${p[1]} jours' }; }
  void _form(BuildContext context) async {
    final cats = await fetchCategories(context.appRead, 'EXPENSE');
    if (!context.mounted) return;
    final label = TextEditingController(), amount = TextEditingController();
    String? cat; var kind = 'RENT'; var day = 5.0; DateTime next = DateTime.now().add(const Duration(days: 1));
    await openSheet(context, title: 'Nouvelle charge', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(controller: label, decoration: const InputDecoration(labelText: 'Libellé')),
      gap(12), DropdownButtonFormField(initialValue: kind, decoration: const InputDecoration(labelText: 'Type'), items: const [DropdownMenuItem(value: 'RENT', child: Text('Loyer')), DropdownMenuItem(value: 'UTILITY', child: Text('Électricité / eau')), DropdownMenuItem(value: 'SCHOOL', child: Text('Scolarité')), DropdownMenuItem(value: 'SUBSCRIPTION', child: Text('Abonnement')), DropdownMenuItem(value: 'INSURANCE', child: Text('Assurance')), DropdownMenuItem(value: 'OTHER', child: Text('Autre'))], onChanged: (v) => set(() => kind = v!)),
      gap(12), AmountField(controller: amount),
      gap(12), categoryPicker(cats, cat, (v) => set(() => cat = v)),
      gap(12), Text('Jour du mois : ${day.round()}', style: inter(14, color: c.pal.ink)), Slider(value: day, min: 1, max: 28, divisions: 27, onChanged: (v) => set(() => day = v)),
      ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.event_rounded), title: Text('Prochaine échéance : ${fmtDate(isoDate(next))}'), onTap: () async { final d = await showDatePicker(context: c, initialDate: next, firstDate: DateTime.now().subtract(const Duration(days: 30)), lastDate: DateTime.now().add(const Duration(days: 400))); if (d != null) set(() => next = d); }),
      FilledButton(onPressed: () async {
        final r = await run(c, () => c.appRead.api.post('/recurring-obligations', {'label': label.text.trim(), 'kind': kind, 'amountMinor': parseAmountInput(amount.text) ?? '0', 'scheduleRule': 'MONTHLY:${day.round()}', 'nextDueDate': isoDate(next), 'categoryId': cat}), success: 'Charge ajoutée');
        if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
      }, child: const Text('Ajouter')),
    ])));
  }
}

// ─── Dettes et créances (UX10) ───
class LiabilitiesTab extends StatefulWidget {
  const LiabilitiesTab({super.key});
  @override
  State<LiabilitiesTab> createState() => _LiabilitiesTabState();
}
class _LiabilitiesTabState extends State<LiabilitiesTab> {
  String filter = 'ALL';
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<Map>(load: (a) async => await a.api.get('/liabilities'), builder: (c, d, _) {
      final s = d['summary'];
      final items = (d['items'] as List).where((i) => filter == 'ALL' || i['kind'] == filter).toList();
      final p = c.pal;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Je dois', style: inter(13, color: p.inkMuted)), Money(s['debtsOutstandingMinor'], size: 22, display: true)]))),
          const SizedBox(width: 12),
          Expanded(child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('On me doit', style: inter(13, color: p.inkMuted)), Money(s['receivablesOutstandingMinor'], size: 22, display: true)]))),
        ]),
        gap(12),
        if (s['lateCount'] > 0) Padding(padding: const EdgeInsets.only(bottom: 12), child: InfoBanner('${s['lateCount']} échéance(s) en retard. L’historique est conservé ; un report se déclare explicitement.', icon: Icons.warning_amber_rounded, color: p.error)),
        Row(children: [
          for (final f in [('ALL', 'Tout'), ('DEBT', 'Dettes'), ('RECEIVABLE', 'Créances'), ('FUTURE_COMMITMENT', 'Engagements')]) Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(label: Text(f.$2), selected: filter == f.$1, onSelected: (_) => setState(() => filter = f.$1))),
          const Spacer(), TextButton.icon(onPressed: () => openLiabilityForm(c), icon: const Icon(Icons.add_rounded), label: const Text('Ajouter')),
        ]),
        gap(12),
        if (items.isEmpty) AppCard(child: EmptyState(icon: Icons.handshake_outlined, title: 'Rien à suivre', message: 'Un emprunt reçu augmente votre trésorerie et votre passif — jamais votre revenu.', action: 'Ajouter', onAction: () => openLiabilityForm(c)))
        else for (final l in items) Padding(padding: const EdgeInsets.only(bottom: 12), child: AppCard(onTap: () => c.push('/money/liabilities/${l['id']}'), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [IconBadge(l['kind'] == 'DEBT' ? Icons.north_east_rounded : l['kind'] == 'RECEIVABLE' ? Icons.south_west_rounded : Icons.event_note_rounded, color: l['kind'] == 'DEBT' ? p.copper : p.primary), const SizedBox(width: 12), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(l['label'], style: inter(15.5, w: FontWeight.w600, color: p.ink)), Text(l['counterpartyName'], style: inter(12.5, color: p.inkMuted))])), Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(l['outstandingMinor']), StatePill(l['state'])])]),
          gap(12), ProgressBar((l['progressPercent'] as num) / 100),
          if (l['nextInstallment'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Prochaine échéance ${fmtDate(l['nextInstallment']['dueDate'])} · ${money((big(l['nextInstallment']['principalDueMinor']) + big(l['nextInstallment']['interestDueMinor'])).toString(), hidden: c.app.hideAmounts)}', style: inter(12.5, color: l['lateCount'] > 0 ? p.error : p.inkMuted))),
        ]))),
      ]);
    }),
  ]);
}

Future<void> openLiabilityForm(BuildContext context) async {
  final accounts = await fetchAccounts(context.appRead);
  if (!context.mounted) return;
  var kind = 'DEBT';
  final cp = TextEditingController(), label = TextEditingController(), amount = TextEditingController(), terms = TextEditingController(), count = TextEditingController(text: '1');
  String? acc; DateTime first = DateTime.now().add(const Duration(days: 30));
  await openSheet(context, title: 'Nouvelle obligation', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    SegmentedButton(segments: const [ButtonSegment(value: 'DEBT', label: Text('Je dois')), ButtonSegment(value: 'RECEIVABLE', label: Text('On me doit')), ButtonSegment(value: 'FUTURE_COMMITMENT', label: Text('Engagement'))], selected: {kind}, onSelectionChanged: (s) => set(() => kind = s.first)),
    gap(12), TextField(controller: cp, decoration: const InputDecoration(labelText: 'Contrepartie')),
    gap(12), TextField(controller: label, decoration: const InputDecoration(labelText: 'Libellé')),
    gap(12), AmountField(controller: amount, label: 'Principal'),
    gap(12), TextField(controller: terms, decoration: const InputDecoration(labelText: 'Conditions / intérêts (facultatif)')),
    if (kind != 'FUTURE_COMMITMENT') ...[gap(12), DropdownButtonFormField<String?>(initialValue: acc, isExpanded: true, decoration: InputDecoration(labelText: kind == 'DEBT' ? 'Argent reçu sur (facultatif)' : 'Argent prêté depuis (facultatif)', helperText: 'Vide = encours déjà existant, sans mouvement de trésorerie'), items: [const DropdownMenuItem<String?>(value: null, child: Text('Encours existant')), for (final a in accounts) DropdownMenuItem<String?>(value: a['id'], child: Text(a['name']))], onChanged: (v) => set(() => acc = v))],
    gap(12), Row(children: [Expanded(child: TextField(controller: count, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Échéances mensuelles'))), const SizedBox(width: 10), Expanded(child: OutlinedButton(onPressed: () async { final d = await showDatePicker(context: c, initialDate: first, firstDate: DateTime.now().subtract(const Duration(days: 365)), lastDate: DateTime.now().add(const Duration(days: 3650))); if (d != null) set(() => first = d); }, child: Text('1re : ${fmtDay(isoDate(first))}')))]),
    gap(16), FilledButton(onPressed: () async {
      final n = int.tryParse(count.text) ?? 1;
      final r = await run(c, () => c.appRead.api.post('/liabilities', {'kind': kind, 'counterpartyName': cp.text.trim(), 'label': label.text.trim(), 'principalMinor': parseAmountInput(amount.text) ?? '0', 'startDate': isoDate(DateTime.now()), if (terms.text.trim().isNotEmpty) 'interestTerms': terms.text.trim(), if (acc != null) 'cashAccountId': acc, 'schedule': {'count': n, 'rule': 'MONTHLY:${first.day.clamp(1, 28)}', 'firstDueDate': isoDate(first)}}), success: 'Enregistré');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: const Text('Enregistrer')),
  ])));
}

class LiabilityDetailScreen extends StatelessWidget {
  final String id;
  const LiabilityDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<List>(load: (a) async => [await a.api.get('/liabilities/$id'), await a.api.get('/liabilities/$id/match-suggestions')], page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, d, _) {
    final l = d[0] as Map; final sugg = d[1] as List;
    final p = c.pal;
    return PageScaffold(title: l['label'], subtitle: '${l['kind'] == 'DEBT' ? 'Dette envers' : l['kind'] == 'RECEIVABLE' ? 'Créance sur' : 'Engagement —'} ${l['counterpartyName']}', back: true, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Restant dû', style: inter(13, color: p.inkMuted)), Money(l['outstandingMinor'], size: 30, display: true)])), Ring(value: (l['progressPercent'] as num) / 100, size: 76, child: Text('${(l['progressPercent'] as num).round()}%', style: sora(15, color: p.ink)))]),
        gap(), KeyValue('Principal initial', Money(l['principalMinor'])), KeyValue('Intérêts payés', Money(l['interestPaidMinor'])), KeyValue('Frais payés', Money(l['feesPaidMinor'])), if (l['interestTerms'] != null) KeyValue('Conditions', Text(l['interestTerms'])),
        gap(8), if (l['state'] == 'ACTIVE') FilledButton.icon(onPressed: () => _repay(c, l), icon: const Icon(Icons.payments_outlined), label: Text(l['kind'] == 'RECEIVABLE' ? 'Enregistrer un encaissement' : 'Enregistrer un remboursement')),
      ])),
      if (sugg.isNotEmpty) ...[gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Rapprochements suggérés', subtitle: 'Ces dépenses ressemblent à une échéance — confirmez explicitement'), for (final s in sugg) ListRow(leading: const IconBadge(Icons.link_rounded, size: 36), title: s['expense']['label'], subtitle: fmtDate(s['expense']['economicDate']), trailing: TextButton(onPressed: () => _repay(c, l, linkExpense: s['expense']), child: const Text('Rapprocher')))]))],
      gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Échéancier'), for (final i in l['installments']) ListRow(leading: IconBadge(Icons.event_rounded, size: 34, color: stateColor(c, i['state'])), title: fmtDate(i['dueDate']), subtitle: i['note'] ?? (i['rescheduledFrom'] != null ? 'Report' : null), trailing: Row(mainAxisSize: MainAxisSize.min, children: [Money((big(i['principalDueMinor']) + big(i['interestDueMinor'])).toString(), size: 13.5), const SizedBox(width: 8), StatePill(i['state']), if (['SCHEDULED', 'LATE', 'PARTIAL'].contains(i['state'])) IconButton(tooltip: 'Reporter', onPressed: () => _reschedule(c, i), icon: const Icon(Icons.update_rounded, size: 19))]))])),
      gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Historique'), if ((l['repayments'] as List).isEmpty) Text('Aucun remboursement.', style: inter(14, color: p.inkMuted)), for (final r in l['repayments']) KeyValue(fmtDate(r['at']), Text('${money(r['principalMinor'], hidden: c.app.hideAmounts)} + int. ${money(r['interestMinor'], hidden: c.app.hideAmounts)}', style: inter(13.5, color: p.ink, tab: true)))])),
    ]);
  });
  void _repay(BuildContext c, Map l, {Map? linkExpense}) async {
    final accounts = await fetchAccounts(c.appRead);
    final cats = l['kind'] == 'FUTURE_COMMITMENT' ? await fetchCategories(c.appRead, 'EXPENSE') : [];
    if (!c.mounted) return;
    final principal = TextEditingController(text: linkExpense?['amountMinor'] ?? ''), interest = TextEditingController(text: '0');
    String? acc = linkExpense?['accountId'], cat;
    await openSheet(c, title: linkExpense == null ? 'Remboursement' : 'Rapprocher la dépense', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const InfoBanner('Le principal réduit la dette (pas une dépense). Les intérêts et frais sont des charges distinctes.'),
      gap(12), accountPicker(s, accounts, acc, (v) => set(() => acc = v)),
      gap(12), AmountField(controller: principal, label: 'Principal'),
      gap(12), TextField(controller: interest, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Intérêts', suffixText: 'FCFA')),
      if (cats.isNotEmpty) ...[gap(12), categoryPicker(cats, cat, (v) => set(() => cat = v))],
      gap(14), FilledButton(onPressed: () async {
        final r = await run(s, () => s.appRead.api.post('/liabilities/${l['id']}/repayments', {'cashAccountId': acc, 'principalMinor': parseAmountInput(principal.text) ?? '0', 'interestMinor': interest.text.replaceAll(RegExp(r'\s'), '').isEmpty ? '0' : interest.text.replaceAll(RegExp(r'\s'), ''), if (linkExpense != null) 'linkExpenseId': linkExpense['id'], if (cat != null) 'categoryId': cat}), success: 'Remboursement confirmé');
        if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); }
      }, child: const Text('Confirmer')),
    ])));
  }
  void _reschedule(BuildContext c, Map i) async {
    final d = await showDatePicker(context: c, helpText: 'Nouvelle échéance (déclarée par vous)', initialDate: DateTime.now().add(const Duration(days: 30)), firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 3650)));
    if (d == null || !c.mounted) return;
    await run(c, () => c.appRead.api.post('/liabilities/installments/${i['id']}/reschedule', {'newDueDate': isoDate(d)}), success: 'Report enregistré (historique conservé)');
    if (c.mounted) c.appRead.bump();
  }
}
