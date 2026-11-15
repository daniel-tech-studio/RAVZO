import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/charts.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../money/money.dart';
import '../savings/savings.dart';
import '../shell.dart';

const widgetNames = {'alerts': 'Événements urgents', 'budget': 'Budget du cycle', 'savings': 'Coffres', 'forecast': 'Prévisions & réservations', 'wealth': 'Patrimoine net', 'liabilities': 'Dettes & créances', 'brvm': 'Portefeuille BRVM', 'recent': 'Opérations récentes'};

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  Future<Map<String, dynamic>> _load(AppState app) async {
    final api = app.api;
    final r = await Future.wait([
      app.cached('/balances/overview').then((x) => x.$1), api.get('/operations'), api.get('/budgets/analytics'), api.get('/savings/goals'),
      api.get('/wealth/overview'), api.get('/liabilities'), api.get('/investments/holdings'), api.get('/activity', query: {'limit': '6'}), api.get('/accounts'),
    ]);
    return {'ov': r[0], 'ops': r[1], 'budget': r[2], 'savings': r[3], 'wealth': r[4], 'liab': r[5], 'holdings': r[6], 'recent': r[7], 'accounts': r[8]};
  }
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final hour = DateTime.now().hour;
    final name = (app.me?['displayName'] ?? '').toString().split(' ').first;
    return PageScaffold(title: '${hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir'}${name.isEmpty ? '' : ', $name'}', subtitle: 'Vue d’ensemble · ${fmtDate(DateTime.now().toIso8601String().substring(0, 10))}',
      onRefresh: () async => app.bump(),
      actions: [IconButton(tooltip: 'Personnaliser l’accueil', onPressed: () => _customize(context), icon: const Icon(Icons.dashboard_customize_outlined))],
      children: [Loader<Map<String, dynamic>>(load: _load, loading: const LoadingList(count: 5), builder: (c, d, stale) => _HomeBody(d: d))]);
  }
  void _customize(BuildContext context) {
    final app = context.appRead;
    var order = List<String>.from(app.widgetOrder);
    final hidden = Set<String>.from(app.hiddenWidgets);
    openSheet(context, (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Glissez pour réordonner, masquez ce qui ne vous sert pas. Les alertes de sécurité et de cohérence restent toujours affichées en tête.', style: inter(13.5, color: c.pal.inkMuted)),
      gap(12),
      SizedBox(height: 420, child: ReorderableListView(buildDefaultDragHandles: true, onReorder: (a, b) => set(() { if (b > a) b--; order.insert(b, order.removeAt(a)); }), children: [
        for (final w in order) SwitchListTile(key: ValueKey(w), value: !hidden.contains(w), title: Text(widgetNames[w] ?? w), secondary: const Icon(Icons.drag_indicator_rounded), onChanged: w == 'alerts' ? null : (v) => set(() => v ? hidden.remove(w) : hidden.add(w))),
      ])),
      FilledButton(onPressed: () { app.setWidgets(order, hidden); Navigator.pop(c); }, child: const Text('Enregistrer')),
    ])), title: 'Personnaliser l’accueil');
  }
}

class _HomeBody extends StatelessWidget {
  final Map<String, dynamic> d;
  const _HomeBody({required this.d});
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final wide = MediaQuery.sizeOf(context).width >= 1100;
    final noAccounts = (d['accounts'] as List).isEmpty;
    final widgets = <Widget>[
      for (final w in app.widgetOrder.where((w) => !app.hiddenWidgets.contains(w) && w != 'alerts'))
        switch (w) { 'budget' => _BudgetWidget(d['budget']), 'savings' => _SavingsWidget(d['savings']), 'forecast' => _ForecastWidget(d['ov']), 'wealth' => _WealthWidget(d['wealth']), 'liabilities' => _LiabWidget(d['liab']), 'brvm' => _BrvmWidget(d['holdings']), 'recent' => _RecentWidget(d['recent']), _ => const SizedBox() },
    ];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _Hero(ov: d['ov']),
      gap(),
      const _QuickActions(),
      gap(),
      _Alerts(ops: d['ops'], ov: d['ov']),
      if (noAccounts) AppCard(child: EmptyState(icon: Icons.account_balance_rounded, title: 'Commencez par un compte', message: 'Ajoutez un compte suivi (banque, Mobile Money, espèces) avec son solde actuel. Tout le reste — revenus, budgets, coffres — s’appuie dessus.', action: 'Ajouter un compte', onAction: () => openAccountForm(context))),
      if (wide) LayoutBuilder(builder: (c, cons) => Wrap(spacing: 16, runSpacing: 16, children: [for (final w in widgets) SizedBox(width: (cons.maxWidth - 16) / 2, child: w)]))
      else ...[for (final w in widgets) Padding(padding: const EdgeInsets.only(bottom: 16), child: w)],
    ]);
  }
}

class _Hero extends StatelessWidget {
  final Map ov;
  const _Hero({required this.ov});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final app = context.app;
    final neg = (ov['recommendedSpendableMinor'] as String).startsWith('-');
    final r = ov['transferRestrictions'] as Map;
    return AppCard(gradient: p.heroGradient, radius: Radii.hero, padding: const EdgeInsets.all(26), child: Stack(children: [
      Positioned(right: -40, top: -60, child: IgnorePointer(child: Container(width: 220, height: 220, decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [p.accent.withValues(alpha: .28), Colors.transparent]))))),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Text('Disponible conseillé', style: inter(14.5, w: FontWeight.w600, color: Colors.white.withValues(alpha: .85))), const SizedBox(width: 8), const DataLabel('ESTIMATED', onDark: true), const Spacer(),
          IconButton(tooltip: app.hideAmounts ? 'Afficher les montants' : 'Masquer les montants', onPressed: app.toggleAmounts, icon: Icon(app.hideAmounts ? Icons.visibility_off_rounded : Icons.visibility_rounded, color: Colors.white70))]),
        const SizedBox(height: 4),
        Money(ov['recommendedSpendableMinor'], size: 40, display: true, weight: FontWeight.w700, color: neg ? const Color(0xFFFFC1BC) : Colors.white),
        const SizedBox(height: 6),
        Text(neg ? 'Vos réservations dépassent votre courant : prudence sur les dépenses non essentielles.' : 'Après réservations : budgets essentiels, charges prévues, échéances et projets.', style: inter(13, color: Colors.white.withValues(alpha: .75))),
        const SizedBox(height: 20),
        Wrap(spacing: 28, runSpacing: 14, children: [
          _HeroStat(label: 'Solde courant (enveloppe)', minor: ov['currentWalletMinor'], tag: 'MANUAL'),
          _HeroStat(label: 'Liquidités suivies', minor: ov['trackedBalanceMinor'], tag: 'MANUAL'),
          _HeroStat(label: 'Solde confirmé prestataire', minor: ov['confirmedBalanceMinor'], tag: ov['dataLabels']['confirmedBalance']),
          _HeroStat(label: 'Affecté aux coffres', minor: ov['allocatedToEnvelopesMinor'], tag: 'MANUAL'),
        ]),
        const SizedBox(height: 18),
        Wrap(spacing: 8, runSpacing: 8, children: [
          _HeroChip(Icons.sync_rounded, 'Registre au ${fmtDateTime(ov['asOf'])}'),
          if (r['paymentsLiveEnabled'] != true) const _HeroChip(Icons.block_rounded, 'Paiements réels non activés'),
          if ((r['blockedGroups'] as List).isNotEmpty) const _HeroChip(Icons.report_gmailerrorred_rounded, 'Sorties bloquées (rapprochement)', alert: true),
          if (r['financialReadOnlyUntil'] != null) const _HeroChip(Icons.lock_clock_rounded, 'Suspension de sécurité', alert: true),
        ]),
      ]),
    ]));
  }
}
class _HeroStat extends StatelessWidget {
  final String label; final String? minor; final String tag;
  const _HeroStat({required this.label, required this.minor, required this.tag});
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label, style: inter(12.5, color: Colors.white70)), const SizedBox(height: 2), Money(minor, size: 17, color: Colors.white, weight: FontWeight.w700), const SizedBox(height: 4), DataLabel(tag, onDark: true)]);
}
class _HeroChip extends StatelessWidget {
  final IconData icon; final String text; final bool alert;
  const _HeroChip(this.icon, this.text, {this.alert = false});
  @override
  Widget build(BuildContext context) => Container(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), decoration: BoxDecoration(color: alert ? const Color(0x55AD443F) : Colors.white.withValues(alpha: .12), borderRadius: BorderRadius.circular(99)), child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 14, color: Colors.white), const SizedBox(width: 6), Text(text, style: inter(12, w: FontWeight.w600, color: Colors.white))]));
}

/// UX02 : ordre adapté à l'usage, accès stable à toutes les actions, aucune exécution automatique.
class _QuickActions extends StatelessWidget {
  const _QuickActions();
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final p = context.pal;
    final actions = <(String, IconData, String, void Function())>[
      ('expense', Icons.shopping_bag_outlined, 'Dépense', () => openExpenseForm(context)),
      ('income', Icons.south_west_rounded, 'Revenu', () => openIncomeWizard(context)),
      ('contribution', Icons.savings_outlined, 'Épargner', () => openQuickContribution(context)),
      ('transfer', Icons.swap_horiz_rounded, 'Transfert', () => openTransferForm(context)),
      ('payment', Icons.north_east_rounded, 'Payer', () => context.go('/money?tab=payments')),
      ('import', Icons.upload_file_rounded, 'Importer', () => context.go('/activity?tab=imports')),
    ]..sort((a, b) => (app.actionUsage[b.$1] ?? 0).compareTo(app.actionUsage[a.$1] ?? 0));
    return SizedBox(height: 92, child: ListView.separated(scrollDirection: Axis.horizontal, itemCount: actions.length, separatorBuilder: (_, _) => const SizedBox(width: 10), itemBuilder: (c, i) {
      final a = actions[i];
      return Pressable(onTap: () { app.countAction(a.$1); a.$4(); }, semanticLabel: a.$3, child: Container(width: 96, decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(18), border: Border.all(color: p.border.withValues(alpha: .7))),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [IconBadge(a.$2, size: 38, color: i == 0 ? p.primary : p.inkSoft), const SizedBox(height: 8), Text(a.$3, style: inter(13, w: FontWeight.w600, color: p.ink))])));
    }));
  }
}

class _Alerts extends StatelessWidget {
  final Map ops; final Map ov;
  const _Alerts({required this.ops, required this.ov});
  @override
  Widget build(BuildContext context) {
    final items = (ops['items'] as List).where((i) => i['urgency'] == 'CRITICAL' || i['urgency'] == 'HIGH').take(4).toList();
    if (items.isEmpty) return const SizedBox();
    final p = context.pal;
    return Padding(padding: const EdgeInsets.only(bottom: 16), child: AppCard(color: p.error.withValues(alpha: .05), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Icon(Icons.priority_high_rounded, color: p.error, size: 20), const SizedBox(width: 6), Text('Interventions requises', style: sora(16, color: p.ink)), const Spacer(), TextButton(onPressed: () => context.push('/operations'), child: const Text('Tout voir'))]),
      for (final i in items) ListRow(leading: IconBadge(i['kind'] == 'PAYMENT' ? Icons.help_outline_rounded : i['kind'] == 'RECONCILIATION' ? Icons.compare_arrows_rounded : Icons.flag_rounded, color: i['urgency'] == 'CRITICAL' ? p.error : p.warning, size: 36), title: i['title'], subtitle: stateFr[i['state']] ?? i['state'], trailing: const Icon(Icons.chevron_right_rounded), onTap: () => goLink(context, i['link'])),
    ])));
  }
}

class _W extends StatelessWidget {
  final String title; final String? link; final Widget child; final String? tag;
  const _W(this.title, this.child, {this.link, this.tag});
  @override
  Widget build(BuildContext context) => AppCard(onTap: link == null ? null : () => goLink(context, link), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    Row(children: [Expanded(child: Text(title, style: sora(16, color: context.pal.ink))), if (tag != null) DataLabel(tag!), if (link != null) Icon(Icons.chevron_right_rounded, color: context.pal.inkMuted)]),
    gap(14), child,
  ]));
}

class _BudgetWidget extends StatelessWidget {
  final Map b;
  const _BudgetWidget(this.b);
  @override
  Widget build(BuildContext context) {
    if (b['cycle'] == null) return _W('Budget du cycle', EmptyState(icon: Icons.donut_large_rounded, title: 'Aucun cycle ouvert', message: 'Ouvrez un cycle à la réception de votre revenu pour suivre vos budgets.', action: 'Ouvrir un cycle', onAction: () => context.go('/money?tab=budgets')));
    final cats = (b['categories'] as List).take(4);
    final t = b['totals'];
    return _W('Budget · ${b['cycle']['label']}', link: '/money?tab=budgets', tag: 'TRACKED', Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Expanded(child: Money(t['spentMinor'], size: 22, display: true)), Text('sur ', style: inter(13, color: context.pal.inkMuted)), Money(t['plannedMinor'], size: 14)]),
      Text('Jour ${b['cycle']['elapsedDays']} / ${b['cycle']['totalDays']} · projection ${money(t['forecastSpentMinor'], hidden: context.app.hideAmounts)}', style: inter(12.5, color: context.pal.inkMuted)),
      gap(14),
      for (final c in cats) Padding(padding: const EdgeInsets.only(bottom: 10), child: CompareBar(label: c['categoryName'] ?? '—', plannedMinor: c['plannedMinor'], actualMinor: c['spentMinor'], status: c['status'], forecastMinor: c['forecastMinor'])),
      if (cats.isEmpty) Text('Aucun budget défini pour ce cycle.', style: inter(13.5, color: context.pal.inkMuted)),
    ]));
  }
}

class _SavingsWidget extends StatelessWidget {
  final Map s;
  const _SavingsWidget(this.s);
  @override
  Widget build(BuildContext context) {
    final goals = (s['goals'] as List).take(4).toList();
    if (goals.isEmpty) return _W('Coffres', EmptyState(icon: Icons.savings_rounded, title: 'Aucun coffre', message: 'Fixez un objectif, une échéance et un programme de versements.', action: 'Créer un coffre', onAction: () => openGoalForm(context)));
    return _W('Coffres · ${s['totals']['progressPercent']} %', link: '/savings', tag: 'MANUAL', Wrap(spacing: 18, runSpacing: 14, children: [for (final g in goals) SizedBox(width: 120, child: Column(children: [
      Ring(value: (g['progressPercent'] as num) / 100, size: 72, color: g['status'] == 'LATE' ? context.pal.warning : null, child: Text('${(g['progressPercent'] as num).round()}%', style: sora(15, color: context.pal.ink))),
      const SizedBox(height: 6), Text(g['name'], style: inter(13, w: FontWeight.w600, color: context.pal.ink), maxLines: 1, overflow: TextOverflow.ellipsis), Money(g['savedMinor'], size: 12.5, compact: true, weight: FontWeight.w500),
    ]))]));
  }
}

class _ForecastWidget extends StatelessWidget {
  final Map ov;
  const _ForecastWidget(this.ov);
  @override
  Widget build(BuildContext context) {
    final r = ov['reservations'];
    final p = context.pal;
    final slices = [DonutSlice('Budgets essentiels', big(r['essentialBudgetsMinor']).toDouble(), p.primary), DonutSlice('Charges prévues', big(r['obligationsMinor']).toDouble(), p.copper), DonutSlice('Échéances de dettes', big(r['debtInstallmentsMinor']).toDouble(), p.info), DonutSlice('Projets d’achat', big(r['purchasePlansMinor']).toDouble(), p.accent)];
    return _W('Réservations jusqu’au ${fmtDate(r['horizon'])}', tag: 'FORECAST', Row(children: [
      Donut(slices: slices, size: 130, center: Money(r['totalMinor'], size: 12.5, compact: true)),
      const SizedBox(width: 16),
      Expanded(child: Column(children: [for (final s in slices) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(children: [Container(width: 10, height: 10, decoration: BoxDecoration(color: s.color, borderRadius: BorderRadius.circular(3))), const SizedBox(width: 8), Expanded(child: Text(s.label, style: inter(13, color: p.inkSoft))), Money(s.value.toInt().toString(), size: 13, compact: true)]))])),
    ]));
  }
}

class _WealthWidget extends StatelessWidget {
  final Map w;
  const _WealthWidget(this.w);
  @override
  Widget build(BuildContext context) {
    final h = (w['history'] as List);
    return _W('Patrimoine net', link: '/wealth', tag: 'ESTIMATED', Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Money(w['netWorthMinor'], size: 24, display: true),
      gap(8),
      if (h.length > 1) AreaChart(height: 110, series: [ChartSeries('Net', [for (final x in h) ChartPoint(fmtDay(x['month']), big(x['netWorthMinor']).toDouble(), raw: x['netWorthMinor'])], context.pal.primary)]),
    ]));
  }
}

class _LiabWidget extends StatelessWidget {
  final Map l;
  const _LiabWidget(this.l);
  @override
  Widget build(BuildContext context) {
    final s = l['summary'];
    final up = (s['upcoming30d'] as List).take(3);
    return _W('Dettes & créances', link: '/money?tab=liabilities', tag: 'MANUAL', Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Je dois', style: inter(12.5, color: context.pal.inkMuted)), Money(s['debtsOutstandingMinor'], size: 17)])), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('On me doit', style: inter(12.5, color: context.pal.inkMuted)), Money(s['receivablesOutstandingMinor'], size: 17)]))]),
      if (s['lateCount'] > 0) Padding(padding: const EdgeInsets.only(top: 8), child: Pill('${s['lateCount']} échéance(s) en retard', color: context.pal.error, icon: Icons.warning_amber_rounded)),
      for (final i in up) ListRow(leading: IconBadge(i['kind'] == 'DEBT' ? Icons.north_east_rounded : Icons.south_west_rounded, size: 34), title: i['label'], subtitle: 'Échéance ${fmtDate(i['dueDate'])}', trailing: Money((big(i['principalDueMinor']) + big(i['interestDueMinor'])).toString(), size: 13.5)),
    ]));
  }
}

class _BrvmWidget extends StatelessWidget {
  final List h;
  const _BrvmWidget(this.h);
  @override
  Widget build(BuildContext context) {
    if (h.isEmpty) return _W('Portefeuille BRVM', Text('Aucune position. Ajoutez votre SGI et vos opérations exécutées depuis Patrimoine.', style: inter(13.5, color: context.pal.inkMuted)), link: '/wealth?tab=brvm');
    return _W('Portefeuille BRVM', link: '/wealth?tab=brvm', Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final x in h.take(4)) ListRow(leading: IconBadge(Icons.candlestick_chart_rounded, size: 34, color: context.pal.copper), title: x['security']['symbol'], subtitle: '${x['quantity']} titres · ${x['freshness']['label']}', trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(x['marketValueMinor'] ?? x['costMinor'], size: 13.5), if (x['unrealizedPnlMinor'] != null) Money(x['unrealizedPnlMinor'], size: 12, signed: true, colorize: true)])), if (h.any((x) => x['lastQuote']?['sourceId'] == 'MANSA')) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Data by MansaAPI', style: inter(11.5, color: context.pal.inkMuted)))]));
  }
}

class _RecentWidget extends StatelessWidget {
  final Map r;
  const _RecentWidget(this.r);
  @override
  Widget build(BuildContext context) {
    final items = r['items'] as List;
    return _W('Opérations récentes', link: '/activity', items.isEmpty ? Text('Aucune opération pour l’instant.', style: inter(13.5, color: context.pal.inkMuted)) : Column(children: [for (final i in items) activityRow(context, i)]));
  }
}

Widget activityRow(BuildContext context, Map i) {
  final p = context.pal;
  final cash = i['cashImpactMinor'] as String;
  final icon = switch (i['businessType']) { 'INCOME' => Icons.south_west_rounded, 'EXPENSE' => Icons.shopping_bag_outlined, 'PAYOUT' => Icons.north_east_rounded, 'TRADE' => Icons.candlestick_chart_rounded, 'REPAYMENT' => Icons.handshake_outlined, 'ASSET_REVALUATION' => Icons.auto_graph_rounded, 'REVERSAL' => Icons.undo_rounded, _ => Icons.swap_horiz_rounded };
  return ListRow(leading: IconBadge(icon, size: 38, color: cash.startsWith('-') ? p.inkSoft : p.primary), title: i['memo'] ?? i['label'], subtitle: '${i['label']} · ${fmtDate(i['economicDate'])}', trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [cash == '0' ? Money(i['magnitudeMinor'], size: 14, color: p.inkMuted) : Money(cash, size: 14, signed: true, colorize: true), DataLabel(i['dataLabel'])]));
}
