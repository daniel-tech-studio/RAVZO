import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:path_provider/path_provider.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/charts.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';
import '../home/home.dart';
import '../money/money.dart';

const _at = ['history', 'analytics', 'imports', 'reconciliation'];

/// UX13 + UX20 : historique complet, analyses avancées, imports et rapprochement.
class ActivityScreen extends StatelessWidget {
  final String? initialTab;
  const ActivityScreen({super.key, this.initialTab});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    return DefaultTabController(length: 4, initialIndex: _at.indexOf(initialTab ?? 'history').clamp(0, 3), child: Scaffold(backgroundColor: p.background, body: SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1240), child: Column(children: [
      Padding(padding: EdgeInsets.fromLTRB(wide ? 36 : 20, wide ? 28 : 12, 20, 0), child: Row(children: [Expanded(child: Text('Activité', style: sora(wide ? 30 : 26, w: FontWeight.w700, color: p.ink))), IconButton(tooltip: 'Recherche globale', onPressed: () => context.push('/search'), icon: const Icon(Icons.search_rounded))])),
      TabBar(isScrollable: true, tabAlignment: TabAlignment.start, padding: EdgeInsets.symmetric(horizontal: wide ? 24 : 8), tabs: const [Tab(text: 'Historique'), Tab(text: 'Analyses'), Tab(text: 'Imports'), Tab(text: 'Rapprochement')]),
      const Expanded(child: TabBarView(children: [_History(), _Analytics(), _Imports(), _Recon()])),
    ]))))));
  }
}

class _History extends StatefulWidget {
  const _History();
  @override
  State<_History> createState() => _HistoryState();
}
class _HistoryState extends State<_History> {
  final items = <Map>[];
  String? cursor, q, types, from;
  bool more = true, busy = false;
  Object? error;
  int seen = -1;
  final search = TextEditingController();
  static const typeFilters = [('', 'Tout'), ('INCOME', 'Revenus'), ('EXPENSE', 'Dépenses'), ('ACCOUNT_TRANSFER,PAYOUT,PAYIN', 'Transferts & paiements'), ('TRADE,DIVIDEND_RECEIPT', 'BRVM'), ('LOAN_RECEIVED,LOAN_GRANTED,REPAYMENT', 'Dettes'), ('ASSET_ACQUISITION,ASSET_REVALUATION,ASSET_DISPOSAL', 'Biens'), ('REVERSAL,RECONCILIATION_ADJUSTMENT,EXPENSE_RECLASS', 'Corrections')];
  @override
  void didChangeDependencies() { super.didChangeDependencies(); final r = context.app.revision; if (r != seen) { seen = r; reset(); } }
  void reset() { items.clear(); cursor = null; more = true; load(); }
  Future<void> load() async {
    if (busy || !more) return;
    setState(() => busy = true);
    try {
      final d = await context.appRead.api.get('/activity', query: {'cursor': cursor, 'limit': '40', 'q': q, 'types': types, 'from': from});
      items.addAll((d['items'] as List).cast<Map>()); cursor = d['nextCursor']; more = d['hasMore'] == true; error = null;
    } catch (e) { error = e; }
    if (mounted) setState(() => busy = false);
  }
  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final p = context.pal;
    return NotificationListener<ScrollNotification>(onNotification: (n) { if (n.metrics.pixels > n.metrics.maxScrollExtent - 400) load(); return false; }, child: ListView(padding: EdgeInsets.fromLTRB(wide ? 36 : 16, 16, wide ? 36 : 16, 110), children: [
      Row(children: [
        Expanded(child: TextField(controller: search, decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Filtrer par libellé'), onSubmitted: (v) { q = v.trim().isEmpty ? null : v.trim(); reset(); })),
        const SizedBox(width: 8),
        PopupMenuButton<String>(tooltip: 'Période', icon: const Icon(Icons.date_range_rounded), onSelected: (v) { from = v.isEmpty ? null : v; reset(); }, itemBuilder: (_) => [const PopupMenuItem(value: '', child: Text('Toute période')), PopupMenuItem(value: isoDate(DateTime.now().subtract(const Duration(days: 7))), child: const Text('7 derniers jours')), PopupMenuItem(value: isoDate(DateTime.now().subtract(const Duration(days: 30))), child: const Text('30 derniers jours')), PopupMenuItem(value: isoDate(DateTime(DateTime.now().year)), child: const Text('Cette année'))]),
        PopupMenuButton<String>(tooltip: 'Exporter', icon: const Icon(Icons.ios_share_rounded), onSelected: (v) => _export(context, v), itemBuilder: (_) => const [PopupMenuItem(value: 'csv', child: Text('Exporter en CSV')), PopupMenuItem(value: 'pdf', child: Text('Exporter en PDF'))]),
      ]),
      gap(12),
      SizedBox(height: 40, child: ListView(scrollDirection: Axis.horizontal, children: [for (final f in typeFilters) Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(label: Text(f.$2), selected: (types ?? '') == f.$1, onSelected: (_) { types = f.$1.isEmpty ? null : f.$1; reset(); }))])),
      gap(12),
      if (error != null && items.isEmpty) ErrorState(error: error!, onRetry: reset)
      else if (items.isEmpty && !busy) const AppCard(child: EmptyState(icon: Icons.receipt_long_rounded, title: 'Aucune opération', message: 'Les opérations confirmées apparaîtront ici avec leur provenance.'))
      else AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final i in items) InkWell(onTap: () => _detail(context, i), child: activityRow(context, i))])),
      if (busy) const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator())),
      if (!more && items.isNotEmpty) Padding(padding: const EdgeInsets.all(16), child: Center(child: Text('Fin de l’historique', style: inter(13, color: p.inkMuted)))),
    ]));
  }
  Future<void> _export(BuildContext context, String fmt) async {
    final app = context.appRead;
    if (!await confirmDanger(context, title: 'Exporter l’historique ?', message: 'Le fichier contient des données personnelles confidentielles. Il est journalisé dans votre audit.${app.hideAmounts ? ' Les montants seront masqués.' : ''}', confirm: 'Exporter')) return;
    try {
      final r = await app.api.raw('GET', '/activity/export', query: {'format': fmt, 'masked': app.hideAmounts ? 'true' : null, 'types': types, 'from': from, 'q': q});
      if (r.statusCode != 200) throw Exception('Export impossible (${r.statusCode})');
      final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
      final f = File('${dir.path}/ravzo-historique-${isoDate(DateTime.now())}.$fmt');
      await f.writeAsBytes(r.bodyBytes);
      if (context.mounted) toast(context, 'Exporté : ${f.path}');
    } catch (e) { if (context.mounted) toast(context, errText(e), error: true); }
  }
  void _detail(BuildContext context, Map i) async {
    final t = await run(context, () => context.appRead.api.get('/ledger/entries/${i['id']}'));
    if (t == null || !context.mounted) return;
    openSheet(context, title: i['label'], (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      KeyValue('Date économique', Text(fmtDate(t['economicDate']))), KeyValue('Enregistré', Text(fmtDateTime(t['postedAt']))), KeyValue('Provenance', DataLabel(i['dataLabel'])),
      if (t['memo'] != null) KeyValue('Libellé', Flexible(child: Text(t['memo'], textAlign: TextAlign.right))),
      if (t['reversedBy'] != null) const InfoBanner('Cette écriture a été contrepassée (correction traçable).', icon: Icons.undo_rounded),
      gap(12), Text('Écriture en partie double', style: sora(15, color: c.pal.ink)), gap(6),
      for (final p in t['postings']) KeyValue(p['ledgerAccount']['name'], Money(p['signedAmountMinor'], size: 13.5, signed: true)),
      gap(8), Text('Réf. ${t['id']}', style: inter(11.5, color: c.pal.inkMuted)),
      if (t['businessType'] == 'EXPENSE' && t['reversedBy'] == null) ...[gap(12), OutlinedButton.icon(onPressed: () => _reverse(c, t['businessId']), icon: const Icon(Icons.undo_rounded), label: const Text('Contrepasser (correction)'))],
    ]));
  }
  void _reverse(BuildContext c, String expenseId) async {
    final reason = TextEditingController();
    await openSheet(c, title: 'Contrepasser la dépense', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const InfoBanner('Une écriture confirmée n’est jamais modifiée : une écriture inverse traçable est ajoutée. Ressaisissez ensuite la dépense correcte.'),
      gap(12), TextField(controller: reason, decoration: const InputDecoration(labelText: 'Motif')),
      gap(14), FilledButton.icon(onPressed: () async { final app = s.appRead; final r = await run(s, () async => app.api.post('/expenses/$expenseId/reverse', {'reason': reason.text.trim(), 'approval': await app.approve('ledger.correction', {'expenseId': expenseId, 'reason': reason.text.trim()})}), success: 'Contrepassation enregistrée'); if (r != null && s.mounted) { Navigator.pop(s); app.bump(); } }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Confirmer (validation forte)')),
    ]));
  }
}

class _Analytics extends StatelessWidget {
  const _Analytics();
  @override
  Widget build(BuildContext context) => TabBody(children: [Loader<Map>(load: (a) async => await a.api.get('/analytics/finance'), builder: (c, d, _) {
    final p = c.pal;
    final m = d['monthly'] as List, cats = d['byCategory'] as List, cyc = d['cycleComparison'] as List;
    final colors = [p.primary, p.copper, p.info, p.accent, p.warning, p.error, p.neutral];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SectionTitle('Revenus et dépenses', subtitle: '${fmtDate(d['period']['from'])} → ${fmtDate(d['period']['to'])} · touchez un mois pour voir ses opérations', trailing: const DataLabel('TRACKED')),
        if (m.length < 2) Text('Pas encore assez d’historique pour une tendance.', style: inter(14, color: p.inkMuted))
        else AreaChart(height: 220, onSelect: (i) => c.go('/activity?tab=history'), series: [
          ChartSeries('Revenus', [for (final x in m) ChartPoint(fmtDay(x['month']), big(x['incomeMinor']).toDouble(), raw: x['incomeMinor'])], p.primary),
          ChartSeries('Dépenses', [for (final x in m) ChartPoint(fmtDay(x['month']), big(x['expenseMinor']).toDouble(), raw: x['expenseMinor'])], p.copper),
        ]),
        gap(8), Wrap(spacing: 16, children: [for (final x in m.reversed.take(3)) Text('${fmtDay(x['month'])} : épargne ${x['savingsRatePercent'] ?? '—'} %', style: inter(12.5, color: p.inkMuted))]),
      ])),
      gap(),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionTitle('Dépenses par catégorie'),
        if (cats.isEmpty) Text('Aucune dépense sur la période.', style: inter(14, color: p.inkMuted))
        else Row(children: [Donut(size: 160, slices: [for (var i = 0; i < cats.length; i++) DonutSlice(cats[i]['name'] ?? '—', big(cats[i]['totalMinor']).toDouble(), colors[i % colors.length])]), const SizedBox(width: 20), Expanded(child: Column(children: [for (var i = 0; i < cats.length && i < 7; i++) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(children: [Container(width: 10, height: 10, decoration: BoxDecoration(color: colors[i % colors.length], borderRadius: BorderRadius.circular(3))), const SizedBox(width: 8), Expanded(child: Text('${cats[i]['name']} (${cats[i]['count']})', style: inter(13, color: p.inkSoft))), Money(cats[i]['totalMinor'], size: 13)]))]))]),
      ])),
      gap(),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionTitle('Comparaison des cycles'),
        if (cyc.isEmpty) Text('Aucun cycle.', style: inter(14, color: p.inkMuted)),
        for (final x in cyc) Padding(padding: const EdgeInsets.only(bottom: 12), child: Pressable(onTap: () => c.push('/money/budgets/cycles/${x['cycleId']}'), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Text(x['label'], style: inter(14, w: FontWeight.w600, color: p.ink))), StatePill(x['state'])]),
          const SizedBox(height: 4), CompareBar(label: 'Dépensé vs revenus', plannedMinor: x['incomeMinor'] == '0' ? x['plannedMinor'] : x['incomeMinor'], actualMinor: x['spentMinor'], status: big(x['spentMinor']) > big(x['incomeMinor']) ? 'EXCEEDED' : 'OK'),
        ]))),
      ])),
    ]);
  })]);
}

class _Imports extends StatelessWidget {
  const _Imports();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    const InfoBanner('Importez un relevé CSV (date;libellé;montant;référence) ou des avis d’opéré SGI (date;sens;symbole;quantité;prix;frais;taxes;référence). Chaque ligne est prévisualisée, les doublons détectés, et rien n’est comptabilisé sans votre décision.', icon: Icons.upload_file_rounded),
    gap(12),
    Row(children: [Expanded(child: FilledButton.icon(onPressed: () => _start(context, 'BANK_CSV'), icon: const Icon(Icons.account_balance_outlined), label: const Text('Relevé de compte'))), const SizedBox(width: 10), Expanded(child: OutlinedButton.icon(onPressed: () => _start(context, 'SGI_TRADES_CSV'), icon: const Icon(Icons.candlestick_chart_outlined), label: const Text('Avis d’opéré SGI')))]),
    gap(),
    Loader<List>(load: (a) async => await a.api.get('/imports') as List, builder: (c, list, _) => list.isEmpty ? const SizedBox() : AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final b in list) ListRow(leading: const IconBadge(Icons.description_outlined), title: b['sourceType'] == 'BANK_CSV' ? 'Relevé' : 'Avis SGI', subtitle: '${fmtDateTime(b['createdAt'])} · ${b['rowCount']} lignes', trailing: StatePill(b['status']), onTap: () => c.push('/activity/imports/${b['id']}'))]))),
  ]);
  Future<void> _start(BuildContext context, String type) async {
    final app = context.appRead;
    final targets = type == 'BANK_CSV' ? await fetchAccounts(app) : [for (final b in (await app.api.get('/investments/brokers')) as List) for (final a in b['accounts']) {'id': a['id'], 'name': '${b['name']} · ${a['accountAlias']}', 'balanceMinor': a['cashBalanceMinor']}];
    if (!context.mounted) return;
    if (targets.isEmpty) { toast(context, type == 'BANK_CSV' ? 'Ajoutez d’abord un compte' : 'Ajoutez d’abord une SGI', error: true); return; }
    final file = await openFile(acceptedTypeGroups: [const XTypeGroup(label: 'CSV', extensions: ['csv', 'txt'])]);
    if (file == null || !context.mounted) return;
    String? target = targets.first['id'];
    await openSheet(context, title: 'Importer ${file.name}', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      accountPicker(c, targets, target, (v) => set(() => target = v), label: type == 'BANK_CSV' ? 'Compte concerné' : 'Compte SGI'),
      gap(14), FilledButton(onPressed: () async {
        final r = await run(c, () async {
          final bytes = await file.readAsBytes();
          final up = await app.api.post('/documents/upload-requests', {'originalName': file.name, 'mimeDeclared': 'text/csv', 'sizeBytes': bytes.length});
          final put = await app.api.raw('PUT', '/documents/${up['documentId']}/content', headers: {'Content-Type': 'application/octet-stream', 'X-Upload-Token': up['uploadToken']}, bytes: bytes);
          if (put.statusCode != 200) throw Exception('Fichier refusé (${put.statusCode}) : contenu non conforme');
          final hash = await Sha256().hash(bytes);
          await app.api.post('/documents/${up['documentId']}/complete', {'sha256': hash.bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()});
          return app.api.post('/imports', {'documentId': up['documentId'], 'sourceType': type, 'targetAccountId': target});
        });
        if (r != null && c.mounted) { Navigator.pop(c); app.bump(); c.push('/activity/imports/${r['id']}'); }
      }, child: const Text('Analyser le fichier')),
    ])));
  }
}

class ImportReviewScreen extends StatefulWidget {
  final String id;
  const ImportReviewScreen({super.key, required this.id});
  @override
  State<ImportReviewScreen> createState() => _ImportReviewScreenState();
}
class _ImportReviewScreenState extends State<ImportReviewScreen> {
  final decisions = <int, String>{};
  @override
  Widget build(BuildContext context) => Loader<List>(load: (a) async => [await a.api.get('/imports/${widget.id}'), await a.api.get('/imports/${widget.id}/rows')], page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, d, _) {
    final b = d[0] as Map, rows = d[1] as List;
    final p = c.pal;
    final done = b['status'] == 'COMMITTED';
    for (final r in rows) { decisions.putIfAbsent(r['rowNumber'], () => r['classification'] == 'NEW' ? 'COMMIT' : 'SKIP'); }
    const label = {'NEW': 'Nouvelle', 'MATCHED': 'Déjà enregistrée', 'POSSIBLE_DUPLICATE': 'Doublon possible', 'INVALID': 'Invalide'};
    return PageScaffold(title: 'Revue d’import', subtitle: '${b['rowCount']} lignes · ${b['status']}', back: true, children: [
      if (b['errorSummary'] != null) InfoBanner(b['errorSummary'], color: p.error, icon: Icons.error_outline_rounded),
      Wrap(spacing: 8, children: [for (final e in (b['summary'] as Map).entries) Pill('${label[e.key] ?? e.key} : ${e.value}', color: e.key == 'NEW' ? p.success : e.key == 'INVALID' ? p.error : p.warning)]),
      gap(12),
      AppCard(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6), child: Column(children: [for (final r in rows) () {
        final n = r['normalizedData'] as Map;
        final can = ['NEW', 'POSSIBLE_DUPLICATE'].contains(r['classification']) && !done;
        return CheckboxListTile(value: r['postedResourceId'] != null || decisions[r['rowNumber']] == 'COMMIT', onChanged: can ? (v) => setState(() => decisions[r['rowNumber']] = v! ? 'COMMIT' : 'SKIP') : null,
          title: Text(n['label'] ?? '${n['side']} ${n['quantity']} ${n['symbol']} @ ${n['unitPrice']}', style: inter(14, w: FontWeight.w600, color: p.ink)),
          subtitle: Text('${n['date']} · ${label[r['classification']]}${r['validationErrors'] != null ? ' · ${r['validationErrors']}' : ''}${r['postedResourceId'] != null ? ' · comptabilisée' : ''}', style: inter(12.5, color: r['classification'] == 'INVALID' ? p.error : p.inkMuted)),
          secondary: n['amountMinor'] != null ? Money(n['amountMinor'], size: 13.5, signed: true, colorize: true) : null);
      }()])),
      gap(),
      if (!done) FilledButton(onPressed: () async {
        final r = await run(context, () => context.appRead.api.post('/imports/${widget.id}/confirm', {'decisions': [for (final e in decisions.entries) {'rowNumber': e.key, 'decision': e.value}]}), success: 'Import comptabilisé');
        if (r != null && mounted) context.appRead.bump();
      }, child: Text('Comptabiliser ${decisions.values.where((v) => v == 'COMMIT').length} ligne(s)')),
    ]);
  });
}

class _Recon extends StatelessWidget {
  const _Recon();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => [await a.api.get('/reconciliation/cases'), await a.api.get('/reconciliation/balance-groups')], builder: (c, d, _) {
      final cases = d[0] as List, groups = d[1] as List;
      final p = c.pal;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const InfoBanner('Un écart inexpliqué bloque toutes les sorties de la balance réelle concernée ; les balances indépendantes restent actives. Toute correction est une écriture compensatoire liée à une preuve — jamais un alignement silencieux.', icon: Icons.compare_arrows_rounded),
        gap(12),
        if (groups.isNotEmpty) ...[SectionTitle('Balances prestataire', trailing: TextButton.icon(onPressed: () async { await run(c, () => c.appRead.api.post('/reconciliation/run'), success: 'Rapprochement effectué'); c.appRead.bump(); }, icon: const Icon(Icons.sync_rounded), label: const Text('Rapprocher'))), AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final g in groups) ListRow(leading: IconBadge(Icons.account_balance_wallet_outlined, color: stateColor(c, g['status'])), title: g['name'], subtitle: g['verifiedAt'] == null ? 'Jamais vérifiée' : 'Vérifiée ${fmtDateTime(g['verifiedAt'])}', trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(g['verifiedBalanceMinor'], size: 13.5), StatePill(g['status'] == 'ACTIVE' ? 'ACTIVE' : 'BLOCKED_OUTBOUND')]))])), gap()],
        const SectionTitle('Cas'),
        if (cases.isEmpty) const AppCard(child: EmptyState(icon: Icons.verified_rounded, title: 'Aucun écart', message: 'Déclarez régulièrement le solde observé de vos comptes pour détecter les écarts.'))
        else AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final x in cases) ListRow(leading: IconBadge(Icons.compare_arrows_rounded, color: stateColor(c, x['status'])), title: reconReason(x['reason']), subtitle: 'Ouvert ${fmtDateTime(x['openedAt'])}', trailing: StatePill(x['status']), onTap: () => c.push('/activity/reconciliation/${x['id']}'))])),
        if (cases.isNotEmpty) Text('', style: inter(1, color: p.ink)),
      ]);
    }),
  ]);
}

String reconReason(String r) {
  const m = {
    'DECLARED_BALANCE_MISMATCH': 'Le solde que vous avez déclaré diffère du registre',
    'PROVIDER_BALANCE_MISMATCH': 'Le solde du prestataire diffère du registre',
    'WEBHOOK_MISMATCH: AMOUNT_MISMATCH': 'Le prestataire signale un montant différent du paiement',
    'WEBHOOK_MISMATCH: CURRENCY_MISMATCH': 'Le prestataire signale une autre devise',
    'WEBHOOK_MISMATCH: UNKNOWN_MERCHANT_REF': 'Événement prestataire sans paiement correspondant',
    'WEBHOOK_MISMATCH: PROVIDER_REF_MISMATCH': 'Référence prestataire incohérente',
    'WEBHOOK_MISMATCH: CONTRADICTS_TERMINAL_FAILED': 'Le prestataire annonce un succès pour un paiement enregistré comme échoué — de l’argent a peut-être quitté le compte',
    'WEBHOOK_MISMATCH: CONTRADICTS_TERMINAL_CANCELLED': 'Le prestataire annonce un succès pour un paiement annulé',
    'WEBHOOK_MISMATCH: CONTRADICTS_TERMINAL_SUCCEEDED': 'Le prestataire annonce un échec pour un paiement enregistré comme réussi',
  };
  return m[r] ?? r;
}

class ReconciliationCaseScreen extends StatelessWidget {
  final String id;
  const ReconciliationCaseScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<Map>(load: (a) async => await a.api.get('/reconciliation/cases/$id'), page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, x, _) {
    final p = c.pal;
    final open = ['OPEN', 'INVESTIGATING'].contains(x['status']);
    return PageScaffold(title: 'Écart de rapprochement', subtitle: reconReason(x['reason']), back: true, children: [
      AppCard(child: Column(children: [KeyValue('Attendu (registre)', Money(x['expectedMinor'])), KeyValue('Observé', Money(x['observedMinor'])), KeyValue('Écart', Money(x['differenceMinor'], signed: true, colorize: true, weight: FontWeight.w700)), KeyValue('Statut', StatePill(x['status'])), if (x['account'] != null) KeyValue('Compte', Text(x['account']['name'])), if (x['group'] != null) KeyValue('Balance', StatePill(x['group']['status']))])),
      if ((x['affectedWallets'] as List).isNotEmpty) ...[gap(), InfoBanner('Enveloppes bloquées en sortie : ${(x['affectedWallets'] as List).map((w) => w['name']).join(', ')}', color: p.warning, icon: Icons.lock_rounded)],
      gap(), AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SectionTitle('Pièces et journal'), for (final e in x['evidence']) KeyValue('${fmtDateTime(e['recordedAt'])} · ${e['kind']}', Flexible(child: Text(e['note'] ?? e['providerRef'] ?? '—', textAlign: TextAlign.right, style: inter(13, color: p.inkSoft))))])),
      if (open) ...[gap(), Row(children: [Expanded(child: OutlinedButton(onPressed: () => _evidence(c), child: const Text('Ajouter une pièce'))), const SizedBox(width: 10), Expanded(child: FilledButton(onPressed: () => _resolve(c, x), child: const Text('Résoudre')))])],
    ]);
  });
  void _evidence(BuildContext c) { final n = TextEditingController(); openSheet(c, title: 'Pièce justificative', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [TextField(controller: n, maxLines: 3, decoration: const InputDecoration(labelText: 'Explication / référence')), gap(14), FilledButton(onPressed: () async { final r = await run(s, () => s.appRead.api.post('/reconciliation/cases/$id/evidence', {'kind': 'NOTE', 'note': n.text.trim()})); if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); } }, child: const Text('Ajouter'))])); }
  void _resolve(BuildContext c, Map x) {
    var res = 'ADJUST'; final ex = TextEditingController();
    openSheet(c, title: 'Résolution', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      RadioGroup<String>(groupValue: res, onChanged: (v) => set(() => res = v!), child: const Column(children: [RadioListTile(value: 'ADJUST', title: Text('Écriture compensatoire'), subtitle: Text('Ajoute une écriture traçable égale à l’écart')), RadioListTile(value: 'DISMISS_WITH_EVIDENCE', title: Text('Classer avec preuve'), subtitle: Text('L’écart est expliqué sans correction'))])),
      gap(8), TextField(controller: ex, maxLines: 3, decoration: const InputDecoration(labelText: 'Explication (obligatoire)')),
      gap(14), FilledButton.icon(onPressed: () async { final app = s.appRead; final params = {'caseId': id, 'resolution': res, 'explanation': ex.text.trim()}; final r = await run(s, () async => app.api.post('/reconciliation/cases/$id/resolve', {'resolution': res, 'explanation': ex.text.trim(), 'approval': await app.approve('reconciliation.resolve', params)}), success: 'Cas résolu'); if (r != null && s.mounted) { Navigator.pop(s); app.bump(); } }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Résoudre (validation forte)')),
    ])));
  }
}

class LedgerRedirect extends StatelessWidget {
  final String kind, id;
  const LedgerRedirect({super.key, required this.kind, required this.id});
  @override
  Widget build(BuildContext context) => Loader<List>(load: (a) async => (await a.api.get('/expenses')) as List, page: true, builder: (c, list, _) {
    final e = list.firstWhere((x) => x['id'] == id, orElse: () => null);
    return PageScaffold(title: e?['label'] ?? 'Dépense', back: true, children: [if (e == null) const Text('Introuvable') else AppCard(child: Column(children: [KeyValue('Montant', Money(e['amountMinor'])), KeyValue('Date', Text(fmtDate(e['economicDate']))), KeyValue('Statut', StatePill(e['status'] == 'POSTED' ? 'CONFIRMED' : e['status'])), KeyValue('Source', Text(e['source']))]))]);
  });
}
