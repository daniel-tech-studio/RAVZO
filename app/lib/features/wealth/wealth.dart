import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/charts.dart';
import '../../design/components.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';
import '../money/money.dart';

const _wt = ['overview', 'assets', 'brvm', 'sgi', 'dividends', 'plans'];

/// UX11/UX12 : patrimoine hybride complet + BRVM complet (portefeuille, marché, dividendes, projets, analyses).
class WealthScreen extends StatelessWidget {
  final String? initialTab;
  const WealthScreen({super.key, this.initialTab});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    return DefaultTabController(length: _wt.length, initialIndex: _wt.indexOf(initialTab ?? 'overview').clamp(0, _wt.length - 1), child: Scaffold(backgroundColor: p.background, body: SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1240), child: Column(children: [
      Padding(padding: EdgeInsets.fromLTRB(wide ? 36 : 20, wide ? 28 : 12, 20, 0), child: Row(children: [Expanded(child: Text('Patrimoine', style: sora(wide ? 30 : 26, w: FontWeight.w700, color: p.ink)))])),
      TabBar(isScrollable: true, tabAlignment: TabAlignment.start, padding: EdgeInsets.symmetric(horizontal: wide ? 24 : 8), tabs: const [Tab(text: 'Valeur nette'), Tab(text: 'Biens'), Tab(text: 'BRVM'), Tab(text: 'SGI'), Tab(text: 'Dividendes'), Tab(text: 'Projets & alertes')]),
      const Expanded(child: TabBarView(children: [_Overview(), _Assets(), _Brvm(), _Sgi(), _Dividends(), _Plans()])),
    ]))))));
  }
}

class _Overview extends StatelessWidget {
  const _Overview();
  @override
  Widget build(BuildContext context) => TabBody(children: [Loader<Map>(load: (a) async => await a.api.get('/wealth/overview'), builder: (c, w, _) {
    final p = c.pal;
    final h = w['history'] as List;
    final br = (w['breakdown'] as List).where((b) => b['key'] != 'DEBTS').toList();
    final colors = {'LIQUID': p.primary, 'BROKER_CASH': p.info, 'SECURITIES': p.copper, 'PHYSICAL': p.accent, 'RECEIVABLES': p.warning};
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(gradient: p.heroGradient, radius: Radii.hero, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Text('Valeur nette', style: inter(14, color: Colors.white70)), const SizedBox(width: 8), const DataLabel('ESTIMATED', onDark: true)]),
        Money(w['netWorthMinor'], size: 38, display: true, color: Colors.white, weight: FontWeight.w700),
        gap(10), Wrap(spacing: 26, runSpacing: 8, children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Actifs', style: inter(12.5, color: Colors.white70)), Money(w['totalAssetsMinor'], color: Colors.white, size: 16)]),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Passifs', style: inter(12.5, color: Colors.white70)), Money(w['totalLiabilitiesMinor'], color: Colors.white, size: 16)]),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Plus-values latentes titres', style: inter(12.5, color: Colors.white70)), Money(w['unrealizedSecuritiesPnlMinor'], color: Colors.white, size: 16, signed: true)]),
        ]),
      ])),
      gap(),
      if (h.length > 1) AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Évolution sur 12 mois', subtitle: 'Registre, titres au coût — survolez ou touchez le graphique'),
        AreaChart(height: 220, series: [ChartSeries('Net', [for (final x in h) ChartPoint(fmtDay(x['month']), big(x['netWorthMinor']).toDouble(), raw: x['netWorthMinor'])], p.primary), ChartSeries('Passifs', [for (final x in h) ChartPoint(fmtDay(x['month']), big(x['liabilitiesMinor']).toDouble(), raw: x['liabilitiesMinor'])], p.copper, fill: false)])])),
      gap(),
      AppCard(child: LayoutBuilder(builder: (c, cons) {
        final donut = Donut(size: 190, slices: [for (final b in br) DonutSlice(b['label'], big(b['valueMinor']).toDouble().abs(), colors[b['key']] ?? p.neutral)], center: Money(w['totalAssetsMinor'], size: 13, compact: true));
        final list = Column(children: [for (final b in w['breakdown']) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [Container(width: 10, height: 10, decoration: BoxDecoration(color: colors[b['key']] ?? p.error, borderRadius: BorderRadius.circular(3))), const SizedBox(width: 10), Expanded(child: Text(b['label'], style: inter(14, color: p.ink))), DataLabel(b['dataLabel']), const SizedBox(width: 10), Money(b['valueMinor'], size: 14)]))]);
        return cons.maxWidth > 640 ? Row(children: [donut, const SizedBox(width: 28), Expanded(child: list)]) : Column(children: [donut, gap(), list]);
      })),
      gap(),
      for (final n in w['notes']) Padding(padding: const EdgeInsets.only(bottom: 8), child: InfoBanner(n)),
      if (w['futureCommitmentsMinor'] != '0') InfoBanner('Engagements futurs (non déduits) : ${money(w['futureCommitmentsMinor'], hidden: c.app.hideAmounts)}'),
    ]);
  })]);
}

class _Assets extends StatelessWidget {
  const _Assets();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    SectionTitle('Biens', subtitle: 'Valorisations datées avec provenance — une réévaluation n’est jamais de l’argent encaissé', trailing: TextButton.icon(onPressed: () => _assetForm(context), icon: const Icon(Icons.add_rounded), label: const Text('Ajouter'))),
    Loader<List>(load: (a) async => await a.api.get('/assets') as List, builder: (c, as, _) => as.isEmpty ? AppCard(child: EmptyState(icon: Icons.home_work_outlined, title: 'Aucun bien', message: 'Terrain, logement, véhicule, équipement : ajoutez-les pour un patrimoine net complet.', action: 'Ajouter un bien', onAction: () => _assetForm(c))) : Column(children: [
      for (final a in as) Padding(padding: const EdgeInsets.only(bottom: 12), child: AppCard(onTap: () => c.push('/wealth/assets/${a['id']}'), child: Row(children: [
        IconBadge(_assetIcon(a['kind']), color: c.pal.copper), const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(a['name'], style: inter(15.5, w: FontWeight.w600, color: c.pal.ink)), Text('Valorisé ${a['lastValuation'] == null ? '—' : fmtDate(a['lastValuation']['valuationDate'])}${a['valuationAgeDays'] != null && a['valuationAgeDays'] > 365 ? ' · ancien' : ''}', style: inter(12.5, color: c.pal.inkMuted))])),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(a['currentValueMinor']), if (a['gainVsCostMinor'] != null) Money(a['gainVsCostMinor'], size: 12, signed: true, colorize: true), StatePill(a['status'] == 'HELD' ? 'ACTIVE' : a['status'])]),
      ]))),
    ])),
  ]);
}
IconData _assetIcon(String k) => switch (k) { 'REAL_ESTATE' => Icons.apartment_rounded, 'LAND' => Icons.landscape_rounded, 'VEHICLE' => Icons.directions_car_rounded, 'EQUIPMENT' => Icons.devices_other_rounded, _ => Icons.category_rounded };

Future<void> _assetForm(BuildContext context) async {
  final accounts = await fetchAccounts(context.appRead);
  if (!context.mounted) return;
  final name = TextEditingController(), cost = TextEditingController(), value = TextEditingController();
  var kind = 'VEHICLE'; String? paid;
  await openSheet(context, title: 'Nouveau bien', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    TextField(controller: name, decoration: const InputDecoration(labelText: 'Nom')),
    gap(12), DropdownButtonFormField(initialValue: kind, decoration: const InputDecoration(labelText: 'Type'), items: const [DropdownMenuItem(value: 'REAL_ESTATE', child: Text('Immobilier')), DropdownMenuItem(value: 'LAND', child: Text('Terrain')), DropdownMenuItem(value: 'VEHICLE', child: Text('Véhicule')), DropdownMenuItem(value: 'EQUIPMENT', child: Text('Équipement')), DropdownMenuItem(value: 'OTHER', child: Text('Autre'))], onChanged: (v) => set(() => kind = v!)),
    gap(12), TextField(controller: cost, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Prix d’acquisition (facultatif)', suffixText: 'FCFA')),
    gap(12), TextField(controller: value, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Valeur estimée actuelle', suffixText: 'FCFA')),
    gap(12), DropdownButtonFormField<String?>(initialValue: paid, isExpanded: true, decoration: const InputDecoration(labelText: 'Payé depuis (achat récent, facultatif)'), items: [const DropdownMenuItem<String?>(value: null, child: Text('Bien déjà détenu')), for (final a in accounts) DropdownMenuItem<String?>(value: a['id'], child: Text(a['name']))], onChanged: (v) => set(() => paid = v)),
    gap(14), FilledButton(onPressed: () async {
      final r = await run(c, () => c.appRead.api.post('/assets', {'name': name.text.trim(), 'kind': kind, if (parseAmountInput(cost.text) != null) 'acquisitionCostMinor': parseAmountInput(cost.text), if (parseAmountInput(value.text) != null) 'currentValueMinor': parseAmountInput(value.text), if (paid != null) 'paidFromAccountId': paid, 'acquiredAt': isoDate(DateTime.now())}), success: 'Bien ajouté');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: const Text('Ajouter')),
  ])));
}

class AssetDetailScreen extends StatelessWidget {
  final String id;
  const AssetDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<Map>(load: (a) async => await a.api.get('/assets/$id'), page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, a, _) {
    final vals = (a['valuations'] as List).reversed.toList();
    return PageScaffold(title: a['name'], back: true, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Expanded(child: Money(a['currentValueMinor'], size: 30, display: true)), const DataLabel('ESTIMATED')]),
        if (vals.length > 1) ...[gap(), AreaChart(height: 160, series: [ChartSeries('Valeur', [for (final v in vals) ChartPoint(fmtDay(v['valuationDate']), big(v['valueMinor']).toDouble(), raw: v['valueMinor'])], c.pal.copper)])],
        gap(), if (a['status'] == 'HELD') Row(children: [Expanded(child: FilledButton(onPressed: () => _revalue(c), child: const Text('Réévaluer'))), const SizedBox(width: 10), Expanded(child: OutlinedButton(onPressed: () => _dispose(c), child: const Text('Céder')))]),
      ])),
      gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Historique des valorisations'), for (final v in a['valuations']) KeyValue('${fmtDate(v['valuationDate'])} · ${{'PURCHASE_PRICE': 'prix d’achat', 'OWNER_ESTIMATE': 'estimation personnelle', 'PROFESSIONAL': 'expertise', 'MARKET_COMPARABLE': 'comparables'}[v['source']] ?? v['source']}', Money(v['valueMinor']))])),
    ]);
  });
  void _revalue(BuildContext c) {
    final v = TextEditingController(); var src = 'OWNER_ESTIMATE';
    openSheet(c, title: 'Nouvelle valorisation', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AmountField(controller: v, label: 'Valeur'), gap(12),
      DropdownButtonFormField(initialValue: src, decoration: const InputDecoration(labelText: 'Source'), items: const [DropdownMenuItem(value: 'OWNER_ESTIMATE', child: Text('Estimation personnelle')), DropdownMenuItem(value: 'PROFESSIONAL', child: Text('Expertise professionnelle')), DropdownMenuItem(value: 'MARKET_COMPARABLE', child: Text('Comparables de marché'))], onChanged: (x) => set(() => src = x!)),
      gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/assets/$id/valuations', {'valueMinor': parseAmountInput(v.text), 'valuationDate': isoDate(DateTime.now()), 'source': src}), success: 'Valorisation enregistrée (non encaissée)'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Enregistrer')),
    ])));
  }
  void _dispose(BuildContext c) async {
    final accounts = await fetchAccounts(c.appRead);
    if (!c.mounted) return;
    final v = TextEditingController(); String? acc;
    openSheet(c, title: 'Cession', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AmountField(controller: v, label: 'Prix de cession'), gap(12), accountPicker(s, accounts, acc, (x) => set(() => acc = x), label: 'Encaissé sur'),
      gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/assets/$id/dispose', {'saleMinor': parseAmountInput(v.text) ?? '0', 'toAccountId': acc, 'date': isoDate(DateTime.now())}), success: 'Cession enregistrée'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Confirmer la cession')),
    ])));
  }
}

class _Brvm extends StatelessWidget {
  const _Brvm();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => [await a.api.get('/investments/holdings'), await a.api.get('/market/securities'), await a.api.get('/market/status')], builder: (c, d, _) {
      final h = d[0] as List, secs = d[1] as List, st = d[2] as Map;
      final p = c.pal;
      final mv = h.fold<BigInt>(BigInt.zero, (s, x) => s + big(x['marketValueMinor'] ?? x['costMinor']));
      final cost = h.fold<BigInt>(BigInt.zero, (s, x) => s + big(x['costMinor']));
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InfoBanner(st['note'], icon: Icons.schedule_rounded, color: st['licensed'] == true ? p.info : p.warning, action: st['provider'] == 'NONE' ? null : TextButton(onPressed: () async { final r = await run(c, () => c.appRead.api.post('/market/refresh')); if (r != null && c.mounted) { toast(c, r['skipped'] == 'TOO_SOON' ? 'Déjà actualisé il y a moins de 15 min' : r['skipped'] != null ? 'Quota du jour réservé : réessayez demain' : '${r['refreshed']} cours actualisés'); c.appRead.bump(); } }, child: const Text('Actualiser'))),
        if (st['lastRefreshAt'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Dernière actualisation ${fmtDateTime(st['lastRefreshAt'])} · ${st['requestsToday']}/${st['dailyQuota']} requêtes aujourd’hui', style: inter(12, color: p.inkMuted))),
        if (st['attribution'] != null) Attribution(st['attribution']),
        gap(12),
        AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Portefeuille', style: inter(13, color: p.inkMuted)), Money(mv.toString(), size: 26, display: true)])), Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Text('Latent', style: inter(12.5, color: p.inkMuted)), Money((mv - cost).toString(), signed: true, colorize: true)])]),
          gap(8), const Text('Jamais « en direct » : cours différés ou saisis manuellement, toujours datés.'),
          for (final x in h) ListRow(leading: IconBadge(Icons.candlestick_chart_rounded, color: p.copper), title: '${x['security']['symbol']} · ${x['quantity']} titres', subtitle: 'PRU ${x['averageCost']} · ${x['costBasisStatus'] == 'INDICATIVE' ? 'coût indicatif' : 'coût SGI'} · ${x['freshness']['label']}', trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(x['marketValueMinor'] ?? x['costMinor'], size: 14), if (x['unrealizedPnlMinor'] != null) Money(x['unrealizedPnlMinor'], size: 12, signed: true, colorize: true) else const DataLabel('INDICATIVE')]), onTap: () => c.push('/wealth/market/${x['security']['id']}')),
          if (h.isEmpty) Text('Aucune position : enregistrez vos opérations exécutées dans l’onglet SGI.', style: inter(13.5, color: p.inkMuted)),
        ])),
        gap(),
        SectionTitle('Marché', subtitle: 'Titres suivis', trailing: TextButton.icon(onPressed: () => _secForm(c), icon: const Icon(Icons.add_rounded), label: const Text('Titre'))),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final s in secs) ListRow(
          leading: IconButton(onPressed: () async { await c.appRead.api.post('/market/securities/${s['id']}/favorite'); c.appRead.bump(); }, icon: Icon(s['isFavorite'] ? Icons.star_rounded : Icons.star_outline_rounded, color: p.copper)),
          title: s['symbol'], subtitle: '${s['name']} · ${s['freshness']['label']}',
          trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Text(s['lastQuote'] == null ? '—' : '${s['lastQuote']['price']} F', style: inter(14, w: FontWeight.w600, tab: true, color: p.ink)), if (s['changePercent'] != null) Text('${(s['changePercent'] as num) >= 0 ? '+' : ''}${(s['changePercent'] as num).toStringAsFixed(2)} %', style: inter(12, w: FontWeight.w600, color: (s['changePercent'] as num) >= 0 ? p.success : p.error))]),
          onTap: () => c.push('/wealth/market/${s['id']}'))])),
      ]);
    }),
  ]);
}
void _secForm(BuildContext context) {
  final sym = TextEditingController(), name = TextEditingController(), sector = TextEditingController();
  openSheet(context, title: 'Ajouter un titre', (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    TextField(controller: sym, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Symbole (ex. SNTS)')), gap(12), TextField(controller: name, decoration: const InputDecoration(labelText: 'Nom')), gap(12), TextField(controller: sector, decoration: const InputDecoration(labelText: 'Secteur (facultatif)')),
    gap(14), FilledButton(onPressed: () async { final r = await run(c, () => c.appRead.api.post('/market/securities', {'symbol': sym.text.trim(), 'name': name.text.trim(), if (sector.text.trim().isNotEmpty) 'sector': sector.text.trim()}), success: 'Titre ajouté'); if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); } }, child: const Text('Ajouter')),
  ]));
}

class SecurityDetailScreen extends StatelessWidget {
  final String id;
  const SecurityDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<Map>(load: (a) async => await a.api.get('/market/securities/$id/quotes'), page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, d, _) {
    final s = d['security'], q = (d['quotes'] as List).reversed.toList(), f = d['freshness'];
    final p = c.pal;
    return PageScaffold(title: s['symbol'], subtitle: s['name'], back: true, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Text(q.isEmpty ? '—' : '${q.last['price']} FCFA', style: sora(30, w: FontWeight.w700, color: p.ink)), const Spacer(), DataLabel(f['state'] == 'STALE' ? 'STALE' : q.isNotEmpty && q.last['quality'] == 'MANUAL_UNVERIFIED' ? 'MANUAL_UNVERIFIED' : 'DELAYED')]),
        Text(q.isEmpty ? 'Aucun cours' : 'Séance du ${fmtDate(q.last['sessionDate'])} · cours de ${fmtDateTime(q.last['asOf'])} · source ${q.last['sourceId'] == 'MANUAL' ? 'saisie manuelle' : q.last['sourceId']}', style: inter(12.5, color: p.inkMuted)),
        if (d['attribution'] != null) Attribution(d['attribution']),
        if (q.length > 1) ...[gap(), AreaChart(height: 200, series: [ChartSeries('Cours', [for (final x in q) ChartPoint(fmtDay(x['sessionDate']), double.parse(x['price']), raw: double.parse(x['price']).round().toString())], p.copper)])],
        gap(), Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton.icon(onPressed: () => _quote(c), icon: const Icon(Icons.edit_outlined), label: const Text('Saisir un cours (non officiel)')),
          OutlinedButton.icon(onPressed: () => _alert(c), icon: const Icon(Icons.notifications_active_outlined), label: const Text('Alerte de cours')),
          OutlinedButton.icon(onPressed: () => _plan(c), icon: const Icon(Icons.flag_outlined), label: const Text('Projet d’achat')),
        ]),
      ])),
    ]);
  });
  void _quote(BuildContext c) { final pr = TextEditingController(); openSheet(c, title: 'Cours manuel', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const InfoBanner('Saisie de secours marquée « non officielle », jamais présentée comme cotation BRVM.'), gap(12), TextField(controller: pr, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Prix', suffixText: 'FCFA')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/market/manual-quotes', {'securityId': id, 'price': pr.text.trim().replaceAll(',', '.'), 'sessionDate': isoDate(DateTime.now())}), success: 'Cours enregistré'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Enregistrer'))])); }
  void _alert(BuildContext c) { final t = TextEditingController(); var trig = 'ABOVE'; openSheet(c, title: 'Alerte de cours', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [SegmentedButton(segments: const [ButtonSegment(value: 'ABOVE', label: Text('Au-dessus')), ButtonSegment(value: 'BELOW', label: Text('En dessous'))], selected: {trig}, onSelectionChanged: (x) => set(() => trig = x.first)), gap(12), TextField(controller: t, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Seuil', suffixText: 'FCFA')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/alerts', {'securityId': id, 'triggerType': trig, 'threshold': t.text.trim()}), success: 'Alerte créée (aucun ordre ne sera passé)'); if (r != null && s.mounted) Navigator.pop(s); }, child: const Text('Créer'))]))); }
  void _plan(BuildContext c) { final b = TextEditingController(), q = TextEditingController(); openSheet(c, title: 'Projet d’achat', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const InfoBanner('Réservation VIRTUELLE de budget dans le disponible conseillé : aucun titre acquis, aucun ordre transmis.'), gap(12), AmountField(controller: b, label: 'Budget réservé'), gap(12), TextField(controller: q, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Quantité visée (facultatif)')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/plans', {'securityId': id, 'budgetReservedMinor': parseAmountInput(b.text), if (q.text.trim().isNotEmpty) 'quantityTarget': q.text.trim()}), success: 'Projet créé'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Créer le projet'))])); }
}

class _Sgi extends StatelessWidget {
  const _Sgi();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => [await a.api.get('/investments/brokers'), await a.api.get('/investments/trades')], builder: (c, d, _) {
      final brokers = d[0] as List, trades = d[1] as List;
      final p = c.pal;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const InfoBanner('Opérations DÉJÀ exécutées chez votre SGI, saisies ou importées depuis vos avis d’opéré. RAVZO ne transmet aucun ordre de bourse.', icon: Icons.gavel_rounded),
        gap(12),
        SectionTitle('Comptes SGI', trailing: TextButton.icon(onPressed: () => _brokerForm(c), icon: const Icon(Icons.add_rounded), label: const Text('SGI'))),
        if (brokers.isEmpty) AppCard(child: EmptyState(icon: Icons.account_balance_rounded, title: 'Aucune SGI', message: 'Chaque SGI a son propre compte espèces, distinct de vos liquidités — jamais compté deux fois.', action: 'Ajouter une SGI', onAction: () => _brokerForm(c))),
        for (final b in brokers) for (final a in b['accounts']) Padding(padding: const EdgeInsets.only(bottom: 12), child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [IconBadge(Icons.account_balance_rounded, color: p.info), const SizedBox(width: 12), Expanded(child: Text('${b['name']} · ${a['accountAlias']}', style: inter(15.5, w: FontWeight.w600, color: p.ink)))]),
          gap(10), KeyValue('Espèces SGI', Money(a['cashBalanceMinor'])), KeyValue('Titres (au coût)', Money(a['securitiesAtCostMinor'])),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.tonal(onPressed: () => _tradeForm(c, a['id']), child: const Text('Opération exécutée')),
            OutlinedButton(onPressed: () => _cashForm(c, a['id']), child: const Text('Mouvement d’espèces')),
          ]),
        ]))),
        gap(),
        const SectionTitle('Journal des opérations'),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [if (trades.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Aucune opération.', style: inter(14, color: p.inkMuted))), for (final t in trades) ListRow(leading: IconBadge(t['side'] == 'BUY' ? Icons.add_shopping_cart_rounded : Icons.sell_outlined, color: t['side'] == 'BUY' ? p.primary : p.copper), title: '${t['side'] == 'BUY' ? 'Achat' : 'Vente'} ${t['quantity']} @ ${t['unitPrice']}', subtitle: '${fmtDateTime(t['executedAt'])} · frais ${money(t['feesMinor'], hidden: c.app.hideAmounts)}${t['externalRef'] != null ? ' · ${t['externalRef']}' : ''}', trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(t['grossMinor'], size: 14), if (t['realizedPnlMinor'] != null) Money(t['realizedPnlMinor'], size: 12, signed: true, colorize: true)]))])),
      ]);
    }),
  ]);
  void _brokerForm(BuildContext c) { final n = TextEditingController(), al = TextEditingController(text: 'Compte titres'), cash = TextEditingController(); openSheet(c, title: 'Nouvelle SGI', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [TextField(controller: n, decoration: const InputDecoration(labelText: 'Nom de la SGI')), gap(12), TextField(controller: al, decoration: const InputDecoration(labelText: 'Alias du compte')), gap(12), TextField(controller: cash, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Solde espèces actuel (facultatif)', suffixText: 'FCFA')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/brokers', {'name': n.text.trim(), 'accountAlias': al.text.trim(), if (parseAmountInput(cash.text) != null) 'openingCashMinor': parseAmountInput(cash.text)}), success: 'SGI ajoutée'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Ajouter'))])); }
  void _cashForm(BuildContext c, String baId) async {
    final accounts = await fetchAccounts(c.appRead);
    if (!c.mounted) return;
    var type = 'DEPOSIT'; String? acc; final amt = TextEditingController();
    openSheet(c, title: 'Mouvement d’espèces SGI', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SegmentedButton(segments: const [ButtonSegment(value: 'DEPOSIT', label: Text('Versement')), ButtonSegment(value: 'WITHDRAWAL', label: Text('Retrait')), ButtonSegment(value: 'FEE', label: Text('Frais'))], selected: {type}, onSelectionChanged: (x) => set(() => type = x.first)),
      gap(12), AmountField(controller: amt), if (type != 'FEE') ...[gap(12), accountPicker(s, accounts, acc, (x) => set(() => acc = x), label: type == 'DEPOSIT' ? 'Depuis' : 'Vers')],
      gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/brokerage-accounts/$baId/cash-movements', {'type': type, 'amountMinor': parseAmountInput(amt.text), if (acc != null) 'counterpartAccountId': acc}), success: 'Mouvement enregistré'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Enregistrer')),
    ])));
  }
  void _tradeForm(BuildContext c, String baId) async {
    final secs = (await c.appRead.api.get('/market/securities')) as List;
    if (!c.mounted) return;
    String? sec; var side = 'BUY'; DateTime when = DateTime.now();
    final q = TextEditingController(), pr = TextEditingController(), fee = TextEditingController(text: '0'), ref = TextEditingController();
    openSheet(c, title: 'Opération exécutée', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SegmentedButton(segments: const [ButtonSegment(value: 'BUY', label: Text('Achat')), ButtonSegment(value: 'SELL', label: Text('Vente'))], selected: {side}, onSelectionChanged: (x) => set(() => side = x.first)),
      gap(12), DropdownButtonFormField<String>(initialValue: sec, isExpanded: true, decoration: const InputDecoration(labelText: 'Titre'), items: [for (final x in secs) DropdownMenuItem(value: x['id'] as String, child: Text('${x['symbol']} — ${x['name']}'))], onChanged: (v) => set(() => sec = v)),
      gap(12), Row(children: [Expanded(child: TextField(controller: q, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Quantité'))), const SizedBox(width: 10), Expanded(child: TextField(controller: pr, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Prix unitaire')))]),
      gap(12), Row(children: [Expanded(child: TextField(controller: fee, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Commissions & taxes', suffixText: 'F'))), const SizedBox(width: 10), Expanded(child: TextField(controller: ref, decoration: const InputDecoration(labelText: 'Réf. avis d’opéré')))]),
      ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.event_rounded), title: Text('Exécutée le ${fmtDate(isoDate(when))}'), onTap: () async { final d = await showDatePicker(context: s, initialDate: when, firstDate: DateTime(2015), lastDate: DateTime.now()); if (d != null) set(() => when = d); }),
      FilledButton(onPressed: () async {
        final r = await run(s, () => s.appRead.api.post('/investments/trades', {'brokerageAccountId': baId, 'securityId': sec, 'side': side, 'quantity': q.text.trim(), 'unitPrice': pr.text.trim().replaceAll(',', '.'), 'feesMinor': fee.text.replaceAll(RegExp(r'\s'), '').isEmpty ? '0' : fee.text.replaceAll(RegExp(r'\s'), ''), 'executedAt': DateTime(when.year, when.month, when.day, 10).toUtc().toIso8601String(), if (ref.text.trim().isNotEmpty) 'externalRef': ref.text.trim()}));
        if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); toast(s, r['duplicate'] == true ? 'Avis déjà enregistré : aucun doublon créé' : 'Opération enregistrée · ${r['costMethodLabel'] ?? ''}'); }
      }, child: const Text('Enregistrer')),
    ])));
  }
}

class _Dividends extends StatelessWidget {
  const _Dividends();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    SectionTitle('Dividendes', subtitle: 'Annonce ≠ encaissement : rien n’est crédité avant réception rapprochée', trailing: TextButton.icon(onPressed: () => _announce(context), icon: const Icon(Icons.campaign_outlined), label: const Text('Annonce'))),
    Loader<List>(load: (a) async => await a.api.get('/investments/dividends') as List, builder: (c, ds, _) => ds.isEmpty ? const AppCard(child: EmptyState(icon: Icons.payments_outlined, title: 'Aucun dividende', message: 'Enregistrez une annonce : les droits attendus sont calculés sur vos positions, sans créditer d’espèces.')) : Column(children: [
      for (final d in ds) Padding(padding: const EdgeInsets.only(bottom: 12), child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Text(d['security']?['symbol'] ?? '—', style: sora(16, color: c.pal.ink)), const SizedBox(width: 8), Text('${d['announcement']['declaredPerShare']} F/titre', style: inter(13, color: c.pal.inkMuted)), const Spacer(), StatePill(d['status'] == 'RECONCILED' ? 'RECONCILED' : 'PENDING')]),
        gap(8), KeyValue('Attendu (${d['quantityEligible']} titres)', Money(d['expectedMinor'])),
        if (d['receipt'] != null) KeyValue('Reçu le ${fmtDate(d['receipt']['receivedAt'])}', Money(d['receipt']['receivedMinor'])) else Align(alignment: Alignment.centerRight, child: FilledButton.tonal(onPressed: () => _receipt(c, d), child: const Text('Rapprocher l’encaissement'))),
      ]))),
    ])),
  ]);
  void _announce(BuildContext c) async {
    final secs = (await c.appRead.api.get('/market/securities')) as List;
    if (!c.mounted) return;
    String? sec; final ps = TextEditingController(), src = TextEditingController(text: 'Avis BRVM');
    openSheet(c, title: 'Annonce de dividende', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [DropdownButtonFormField<String>(initialValue: sec, decoration: const InputDecoration(labelText: 'Titre'), items: [for (final x in secs) DropdownMenuItem(value: x['id'] as String, child: Text(x['symbol']))], onChanged: (v) => set(() => sec = v)), gap(12), TextField(controller: ps, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Dividende par titre', suffixText: 'F')), gap(12), TextField(controller: src, decoration: const InputDecoration(labelText: 'Source')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/dividends/announcements', {'securityId': sec, 'declaredPerShare': ps.text.trim(), 'source': src.text.trim()}), success: 'Annonce enregistrée (aucun crédit)'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Enregistrer'))])));
  }
  void _receipt(BuildContext c, Map d) { final a = TextEditingController(text: d['expectedMinor']); openSheet(c, title: 'Encaissement reçu', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const InfoBanner('Montant effectivement crédité sur votre compte espèces SGI (net de retenues).'), gap(12), AmountField(controller: a), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/investments/dividends/${d['id']}/match-receipt', {'receivedMinor': parseAmountInput(a.text), 'receivedAt': isoDate(DateTime.now())}), success: 'Dividende encaissé et rapproché'); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Confirmer'))])); }
}

class _Plans extends StatelessWidget {
  const _Plans();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => [await a.api.get('/investments/plans'), await a.api.get('/investments/alerts'), await a.api.get('/market/securities')], builder: (c, d, _) {
      final plans = d[0] as List, alerts = d[1] as List, secs = d[2] as List;
      String sym(String id) => secs.firstWhere((s) => s['id'] == id, orElse: () => {'symbol': '—'})['symbol'];
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionTitle('Projets d’achat', subtitle: 'Réservations virtuelles uniquement'),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [if (plans.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Créez un projet depuis la fiche d’un titre.', style: inter(14, color: c.pal.inkMuted))), for (final p in plans) ListRow(leading: const IconBadge(Icons.flag_outlined), title: p['security']?['symbol'] ?? '—', subtitle: p['quantityTarget'] != null ? '${p['quantityTarget']} titres visés' : null, trailing: Row(mainAxisSize: MainAxisSize.min, children: [Money(p['budgetReservedMinor'], size: 14), const SizedBox(width: 8), StatePill(p['state']), if (p['state'] == 'ACTIVE') PopupMenuButton<String>(onSelected: (v) async { await run(c, () => c.appRead.api.post('/investments/plans/${p['id']}/close', {'state': v})); c.appRead.bump(); }, itemBuilder: (_) => const [PopupMenuItem(value: 'EXECUTED_EXTERNALLY', child: Text('Exécuté chez la SGI')), PopupMenuItem(value: 'CANCELLED', child: Text('Abandonner'))])]))])),
        gap(),
        const SectionTitle('Alertes de cours'),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [if (alerts.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Aucune alerte.', style: inter(14, color: c.pal.inkMuted))), for (final a in alerts) SwitchListTile(value: a['enabled'], onChanged: (v) async { await c.appRead.api.patch('/investments/alerts/${a['id']}', {'enabled': v}); c.appRead.bump(); }, title: Text('${sym(a['securityId'])} ${a['triggerType'] == 'ABOVE' ? '≥' : '≤'} ${a['threshold']} F'), subtitle: Text(a['lastTriggeredAt'] == null ? 'Jamais déclenchée' : 'Déclenchée ${fmtDateTime(a['lastTriggeredAt'])}'))])),
      ]);
    }),
  ]);
}

/// Mention obligatoire de la licence MansaAPI partout où ses cours apparaissent.
class Attribution extends StatelessWidget {
  final Map a;
  const Attribution(this.a, {super.key});
  @override
  Widget build(BuildContext context) => Align(alignment: Alignment.centerLeft, child: TextButton.icon(style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact), onPressed: () => launchUrl(Uri.parse(a['url'])), icon: const Icon(Icons.open_in_new_rounded, size: 14), label: Text(a['text'], style: inter(12, w: FontWeight.w600, color: context.pal.primary))));
}
