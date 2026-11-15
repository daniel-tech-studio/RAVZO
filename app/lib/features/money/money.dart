import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/api.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../home/home.dart';
import '../shell.dart';
import 'budgets.dart';
import 'payments.dart';
export 'budgets.dart';

const _tabs = ['accounts', 'budgets', 'obligations', 'liabilities', 'payments'];
const _tabLabels = ['Comptes', 'Budgets', 'Charges', 'Dettes', 'Paiements'];

/// UX04 : espace hybride — soldes/comptes et actions essentielles réunis.
class MoneyScreen extends StatelessWidget {
  final String? initialTab;
  const MoneyScreen({super.key, this.initialTab});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    return DefaultTabController(length: _tabs.length, initialIndex: _tabs.indexOf(initialTab ?? 'accounts').clamp(0, 4), child: Scaffold(
      backgroundColor: p.background,
      body: SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1240), child: Column(children: [
        Padding(padding: EdgeInsets.fromLTRB(wide ? 36 : 20, wide ? 28 : 12, wide ? 36 : 12, 0), child: Row(children: [
          Expanded(child: Text('Argent', style: sora(wide ? 30 : 26, w: FontWeight.w700, color: p.ink))),
          FilledButton.tonalIcon(onPressed: () => openExpenseForm(context), icon: const Icon(Icons.add_rounded), label: const Text('Dépense')),
          const SizedBox(width: 8),
          FilledButton.icon(onPressed: () => openIncomeWizard(context), icon: const Icon(Icons.south_west_rounded), label: const Text('Revenu')),
        ])),
        TabBar(isScrollable: true, tabAlignment: TabAlignment.start, padding: EdgeInsets.symmetric(horizontal: wide ? 24 : 8), tabs: [for (final t in _tabLabels) Tab(text: t)]),
        const Expanded(child: TabBarView(children: [_AccountsTab(), BudgetsTab(), ObligationsTab(), LiabilitiesTab(), PaymentsTab()])),
      ])))),
    ));
  }
}

class TabBody extends StatelessWidget {
  final List<Widget> children;
  const TabBody({super.key, required this.children});
  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    return ListView(padding: EdgeInsets.fromLTRB(wide ? 36 : 16, 16, wide ? 36 : 16, 110), children: [for (var i = 0; i < children.length; i++) Enter(index: i, child: children[i])]);
  }
}

// ─── Comptes ───
const accountTypeFr = {'EXTERNAL_TRACKED': 'Compte suivi', 'CASH_MANUAL': 'Espèces', 'BROKER_CASH': 'Espèces SGI', 'CONTROLLED_PSP': 'Prestataire'};
IconData accountIcon(String t) => switch (t) { 'CASH_MANUAL' => Icons.payments_outlined, 'BROKER_CASH' => Icons.candlestick_chart_outlined, 'CONTROLLED_PSP' => Icons.phone_android_rounded, _ => Icons.account_balance_outlined };

class _AccountsTab extends StatelessWidget {
  const _AccountsTab();
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => (await a.api.get('/accounts')) as List, builder: (c, accts, _) {
      if (accts.isEmpty) return AppCard(child: EmptyState(icon: Icons.account_balance_rounded, title: 'Aucun compte', message: 'Ajoutez vos comptes bancaires, Mobile Money et espèces avec leur solde actuel. Ils sont « suivis manuellement » : RAVZO ne prétend pas les contrôler.', action: 'Ajouter un compte', onAction: () => openAccountForm(c)));
      final total = accts.where((a) => a['type'] != 'BROKER_CASH').fold<BigInt>(BigInt.zero, (s, a) => s + big(a['balanceMinor']));
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SectionTitle('Mes comptes', subtitle: 'Total suivi : ${money(total.toString(), hidden: c.app.hideAmounts)}', trailing: TextButton.icon(onPressed: () => openAccountForm(c), icon: const Icon(Icons.add_rounded), label: const Text('Ajouter'))),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final a in accts) ListRow(
          leading: IconBadge(accountIcon(a['type'])), title: a['name'], subtitle: '${accountTypeFr[a['type']] ?? a['type']}${a['institution'] != null ? ' · ${a['institution']}' : ''}',
          trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(a['balanceMinor'], size: 15.5), DataLabel(a['dataLabel'])]),
          onTap: () => c.push('/money/accounts/${a['id']}'))])),
        gap(),
        Row(children: [Expanded(child: OutlinedButton.icon(onPressed: () => openTransferForm(c), icon: const Icon(Icons.swap_horiz_rounded), label: const Text('Transfert entre comptes'))), const SizedBox(width: 10), Expanded(child: OutlinedButton.icon(onPressed: () => c.push('/money/budgets/off-cycle'), icon: const Icon(Icons.link_rounded), label: const Text('Hors cycle')))]),
      ]);
    }),
    gap(),
    const SectionTitle('Enveloppes', subtitle: 'Répartition virtuelle de vos liquidités — n’ajoute aucun argent'),
    Loader<List>(load: (a) async => (await a.api.get('/wallets')) as List, builder: (c, ws, _) => AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final w in ws) ListRow(
      leading: IconBadge(w['kind'] == 'CURRENT' ? Icons.wallet_rounded : w['kind'] == 'SAVINGS' ? Icons.savings_outlined : Icons.inventory_2_outlined, color: w['kind'] == 'CURRENT' ? c.pal.primary : c.pal.copper),
      title: w['name'], subtitle: w['kind'] == 'CURRENT' ? 'Reliquat disponible' : w['kind'] == 'SAVINGS' ? 'Coffre · ${w['protectionMode'] == 'ADVISORY' ? 'discipline indicative' : 'protégé'}' : 'Réserve', trailing: Money(w['allocatedMinor']),
      onTap: w['savingsGoalId'] != null ? () => c.go('/savings/${w['savingsGoalId']}') : null)]))),
  ]);
}

Future<List> fetchAccounts(AppState a, {bool includeBroker = false}) async => ((await a.api.get('/accounts')) as List).where((x) => includeBroker || x['type'] != 'BROKER_CASH').toList();
Future<List> fetchCategories(AppState a, String type) async => (await a.api.get('/categories', query: {'type': type})) as List;

Widget accountPicker(BuildContext c, List accounts, String? value, ValueChanged<String?> onChanged, {String label = 'Compte'}) => DropdownButtonFormField<String>(
  initialValue: value, isExpanded: true, decoration: InputDecoration(labelText: label), validator: (v) => v == null ? 'Choisissez un compte' : null, onChanged: onChanged,
  items: [for (final a in accounts) DropdownMenuItem(value: a['id'] as String, child: Text('${a['name']} · ${money(a['balanceMinor'], hidden: c.app.hideAmounts)}', overflow: TextOverflow.ellipsis))]);
Widget categoryPicker(List cats, String? value, ValueChanged<String?> onChanged, {String label = 'Catégorie', bool optional = false}) => DropdownButtonFormField<String>(
  initialValue: value, isExpanded: true, decoration: InputDecoration(labelText: label, helperText: optional ? 'Laisser vide : suggestion automatique (modifiable)' : null), onChanged: onChanged,
  items: [if (optional) const DropdownMenuItem<String>(value: null, child: Text('Suggestion automatique')), for (final c in cats) DropdownMenuItem(value: c['id'] as String, child: Text(c['name']))]);

Future<void> openAccountForm(BuildContext context) {
  final name = TextEditingController(), inst = TextEditingController(), opening = TextEditingController(text: '0');
  var type = 'EXTERNAL_TRACKED';
  var spendable = true;
  final form = GlobalKey<FormState>();
  return openSheet(context, title: 'Ajouter un compte', (c) => StatefulBuilder(builder: (c, set) => Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    SegmentedButton<String>(segments: const [ButtonSegment(value: 'EXTERNAL_TRACKED', label: Text('Banque / Mobile Money'), icon: Icon(Icons.account_balance_outlined)), ButtonSegment(value: 'CASH_MANUAL', label: Text('Espèces'), icon: Icon(Icons.payments_outlined))], selected: {type}, onSelectionChanged: (s) => set(() => type = s.first)),
    gap(14), TextFormField(controller: name, decoration: const InputDecoration(labelText: 'Nom (ex. MTN MoMo perso)'), validator: (v) => (v ?? '').trim().isEmpty ? 'Nom requis' : null),
    gap(12), TextFormField(controller: inst, decoration: const InputDecoration(labelText: 'Établissement (facultatif)')),
    gap(12), TextFormField(controller: opening, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Solde actuel déclaré', suffixText: 'FCFA', helperText: 'Enregistré comme solde d’ouverture « déclaré », traçable'), validator: (v) => RegExp(r'^-?[\d\s]+$').hasMatch(v ?? '') ? null : 'Montant entier'),
    SwitchListTile(contentPadding: EdgeInsets.zero, value: spendable, onChanged: (v) => set(() => spendable = v), title: const Text('Compter dans le disponible conseillé')),
    gap(8),
    FilledButton(onPressed: () async {
      if (!form.currentState!.validate()) return;
      final r = await run(c, () => c.appRead.api.post('/accounts', {'name': name.text.trim(), 'type': type, if (inst.text.trim().isNotEmpty) 'institution': inst.text.trim(), 'openingBalanceMinor': opening.text.replaceAll(RegExp(r'\s'), ''), 'includeInSpendable': spendable}), success: 'Compte ajouté');
      if (r != null && c.mounted) { Navigator.pop(c); c.appRead.bump(); }
    }, child: const Text('Ajouter le compte')),
  ]))));
}

/// Dépense manuelle ; hors ligne → brouillon local à confirmer individuellement (D44).
Future<void> openExpenseForm(BuildContext context, {String? accountId, String? occurrenceId, String? presetLabel, String? presetAmount}) async {
  final app = context.appRead;
  final amount = TextEditingController(text: presetAmount ?? ''), label = TextEditingController(text: presetLabel ?? ''), merchant = TextEditingController();
  final form = GlobalKey<FormState>();
  String? acc = accountId, cat;
  DateTime date = DateTime.now();
  List accounts = [], cats = [];
  try { accounts = await fetchAccounts(app); cats = await fetchCategories(app, 'EXPENSE'); } on ApiError catch (e) { if (!e.offline) rethrow; accounts = (app.store.get<List>('c:/accounts') ?? []); }
  if (!context.mounted) return;
  if (accounts.isEmpty && app.online) { toast(context, 'Ajoutez d’abord un compte', error: true); return; }
  await openSheet(context, title: app.online ? 'Nouvelle dépense' : 'Nouvelle dépense (brouillon hors ligne)', (c) => StatefulBuilder(builder: (c, set) => Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    if (!app.online) const InfoBanner('Hors ligne : cette dépense sera enregistrée comme brouillon et ne sera appliquée qu’après votre confirmation individuelle au retour du réseau.', icon: Icons.cloud_off_rounded),
    if (!app.online) gap(12),
    AmountField(controller: amount, autofocus: true),
    gap(12), TextFormField(controller: label, decoration: const InputDecoration(labelText: 'Libellé'), validator: (v) => (v ?? '').trim().isEmpty ? 'Libellé requis' : null,
      onChanged: (v) async { if (cat == null && v.length > 3 && app.online) { try { final s = await app.api.get('/categories/suggest', query: {'label': v}); if (s['confidence'] != 'DEFAULT') set(() => cat = s['categoryId']); } catch (_) {} } }),
    gap(12), TextFormField(controller: merchant, decoration: const InputDecoration(labelText: 'Marchand (facultatif)')),
    gap(12), if (accounts.isNotEmpty) accountPicker(c, accounts, acc, (v) => set(() => acc = v)),
    gap(12), if (cats.isNotEmpty) categoryPicker(cats, cat, (v) => set(() => cat = v), optional: true),
    gap(6), ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.event_rounded), title: Text('Date : ${fmtDate(isoDate(date))}'), onTap: () async { final d = await showDatePicker(context: c, initialDate: date, firstDate: DateTime(2020), lastDate: DateTime.now()); if (d != null) set(() => date = d); }),
    gap(8),
    FilledButton(onPressed: () async {
      if (!form.currentState!.validate()) return;
      final body = {'accountId': acc, 'amountMinor': parseAmountInput(amount.text), 'label': label.text.trim(), if (merchant.text.trim().isNotEmpty) 'merchant': merchant.text.trim(), if (cat != null) 'categoryId': cat, 'economicDate': isoDate(date), if (occurrenceId != null) 'obligationOccurrenceId': occurrenceId};
      if (!app.online) { await app.addLocalDraft('EXPENSE', body); if (c.mounted) { Navigator.pop(c); toast(c, 'Brouillon enregistré — à confirmer dans Synchronisation'); } return; }
      final r = await run(c, () => app.api.post('/expenses', body, true));
      if (r != null && c.mounted) {
        Navigator.pop(c); app.bump();
        final w = (r['warnings'] as List);
        toast(c, w.isEmpty ? 'Dépense enregistrée' : w.first['code'] == 'BUDGET_EXCEEDED' ? 'Enregistrée — budget dépassé (non bloquant)' : 'Enregistrée — seuil d’alerte budgétaire atteint', error: w.isNotEmpty);
      }
    }, child: Text(app.online ? 'Enregistrer la dépense' : 'Enregistrer le brouillon')),
  ]))));
}

/// UX05 : revenu → répartition → vérification/confirmation (aucune affectation sans confirmation explicite).
Future<void> openIncomeWizard(BuildContext context, {Map? existing}) async {
  final app = context.appRead;
  List accounts = [], cats = [];
  try { accounts = await fetchAccounts(app); cats = await fetchCategories(app, 'INCOME'); } catch (e) { if (context.mounted) toast(context, errText(e), error: true); return; }
  if (!context.mounted) return;
  if (accounts.isEmpty) { toast(context, 'Ajoutez d’abord un compte', error: true); return; }
  await openSheet(context, title: existing == null ? 'Nouveau revenu' : 'Répartir le revenu', (c) => _IncomeWizard(accounts: accounts, cats: cats, existing: existing));
}
class _IncomeWizard extends StatefulWidget {
  final List accounts, cats;
  final Map? existing;
  const _IncomeWizard({required this.accounts, required this.cats, this.existing});
  @override
  State<_IncomeWizard> createState() => _IncomeWizardState();
}
class _IncomeWizardState extends State<_IncomeWizard> {
  int step = 0;
  final amount = TextEditingController(), source = TextEditingController(text: 'Salaire');
  final form = GlobalKey<FormState>();
  String? acc, cat;
  Map? income, proposals;
  List wallets = [];
  final alloc = <String, TextEditingController>{};
  bool busy = false;
  @override
  void initState() {
    super.initState();
    cat = widget.cats.cast<Map?>().firstWhere((c) => c!['name'] == 'Salaire', orElse: () => null)?['id'];
    acc = widget.accounts.length == 1 ? widget.accounts.first['id'] : null;
    if (widget.existing != null) WidgetsBinding.instance.addPostFrameCallback((_) => _prepare(widget.existing!));
  }
  Future<void> _prepare(Map r) async {
    final app = context.appRead;
    income = r;
    proposals = await run<dynamic>(context, () => app.api.post('/incomes/${r['id']}/allocation-proposals')) as Map?;
    wallets = ((await app.api.get('/wallets')) as List).where((w) => w['kind'] != 'CURRENT').toList();
    for (final w in wallets) { final pr = (proposals?['proposals'] as List? ?? []).firstWhere((x) => x['walletId'] == w['id'], orElse: () => null); alloc[w['id']] = TextEditingController(text: pr == null ? '' : pr['amountMinor']); }
    if (mounted) setState(() => step = 1);
  }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final steps = ['Revenu', 'Répartition', 'Vérification'];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [for (var i = 0; i < 3; i++) Expanded(child: Column(children: [AnimatedContainer(duration: Motion.d(context, Motion.base), height: 5, margin: const EdgeInsets.symmetric(horizontal: 3), decoration: BoxDecoration(color: i <= step ? p.primary : p.border, borderRadius: BorderRadius.circular(5))), const SizedBox(height: 6), Text(steps[i], style: inter(12, w: i == step ? FontWeight.w700 : FontWeight.w500, color: i == step ? p.primary : p.inkMuted))]))]),
      gap(18),
      SwapValue(valueKey: step, child: switch (step) { 0 => _s0(), 1 => _s1(), _ => _s2() }),
    ]);
  }
  Widget _s0() => Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    AmountField(controller: amount, autofocus: true, label: 'Montant reçu'),
    gap(12), TextFormField(controller: source, decoration: const InputDecoration(labelText: 'Source'), validator: (v) => (v ?? '').trim().isEmpty ? 'Source requise' : null),
    gap(12), accountPicker(context, widget.accounts, acc, (v) => setState(() => acc = v), label: 'Compte crédité'),
    gap(12), categoryPicker(widget.cats, cat, (v) => setState(() => cat = v)),
    gap(8), Text('Le revenu est reconnu une seule fois. Un transfert ultérieur entre vos comptes ne crée jamais un second revenu.', style: inter(12.5, color: context.pal.inkMuted)),
    gap(14),
    FilledButton(onPressed: busy ? null : () async {
      if (!form.currentState!.validate()) return;
      setState(() => busy = true);
      final app = context.appRead;
      final r = await run(context, () => app.api.post('/incomes', {'accountId': acc, 'source': source.text.trim(), 'grossMinor': parseAmountInput(amount.text), if (cat != null) 'categoryId': cat}, true));
      if (r != null) { app.bump(); await _prepare(r); }
      if (mounted) setState(() => busy = false);
    }, child: const Text('Enregistrer et répartir')),
  ]));
  BigInt get allocated => alloc.values.fold(BigInt.zero, (s, c) => s + (BigInt.tryParse(parseAmountInput(c.text) ?? '0') ?? BigInt.zero));
  Widget _s1() {
    final gross = big(income!['grossMinor']);
    final rest = gross - allocated;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      InfoBanner('Suggestions modifiables issues de vos programmes d’épargne. Rien n’est affecté avant votre confirmation.', icon: Icons.lightbulb_outline_rounded),
      gap(12),
      if (wallets.isEmpty) Text('Aucun coffre ni réserve : tout restera dans le portefeuille courant.', style: inter(14, color: context.pal.inkMuted)),
      for (final w in wallets) Padding(padding: const EdgeInsets.only(bottom: 10), child: TextField(controller: alloc[w['id']], keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: w['name'], prefixIcon: Icon(w['kind'] == 'SAVINGS' ? Icons.savings_outlined : Icons.inventory_2_outlined), suffixText: 'FCFA'))),
      KeyValue('Reste au courant', Money(rest.toString(), color: rest < BigInt.zero ? context.pal.error : null)),
      gap(12),
      Row(children: [Expanded(child: OutlinedButton(onPressed: () { Navigator.pop(context); }, child: const Text('Plus tard'))), const SizedBox(width: 10), Expanded(child: FilledButton(onPressed: rest < BigInt.zero ? null : () => setState(() => step = 2), child: const Text('Vérifier')))]),
    ]);
  }
  Widget _s2() {
    final lines = [for (final w in wallets) if ((parseAmountInput(alloc[w['id']]!.text)) != null) (w, parseAmountInput(alloc[w['id']]!.text)!)];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(color: context.pal.surfaceAlt, child: Column(children: [
        KeyValue('Revenu', Money(income!['grossMinor'])), KeyValue('Source', Text(income!['source'])),
        const Divider(height: 18),
        for (final l in lines) KeyValue('→ ${l.$1['name']}', Money(l.$2)),
        KeyValue('→ Portefeuille courant', Money((big(income!['grossMinor']) - allocated).toString())),
      ])),
      gap(10),
      Text('Mouvements d’affectation internes uniquement : votre patrimoine total ne change pas.', style: inter(12.5, color: context.pal.inkMuted)),
      gap(14),
      FilledButton(onPressed: busy ? null : () async {
        setState(() => busy = true);
        final r = await run(context, () => context.appRead.api.post('/incomes/${income!['id']}/confirm-allocations', {'allocations': [for (final l in lines) {'walletId': l.$1['id'], 'amountMinor': l.$2}]}, true), success: 'Répartition confirmée');
        if (r != null && mounted) { context.appRead.bump(); Navigator.pop(context); }
        if (mounted) setState(() => busy = false);
      }, child: const Text('Confirmer la répartition')),
      TextButton(onPressed: () => setState(() => step = 1), child: const Text('Modifier')),
    ]);
  }
}

Future<void> openTransferForm(BuildContext context) async {
  final app = context.appRead;
  final accounts = await fetchAccounts(app, includeBroker: true);
  if (!context.mounted) return;
  String? from, to;
  final amount = TextEditingController(), fee = TextEditingController(text: '0');
  final form = GlobalKey<FormState>();
  await openSheet(context, title: 'Transfert entre mes comptes', (c) => StatefulBuilder(builder: (c, set) => Form(key: form, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    const InfoBanner('Déplacement de trésorerie entre vos comptes suivis : ni revenu ni dépense. Les frais sont comptés séparément.'),
    gap(12), accountPicker(c, accounts, from, (v) => set(() => from = v), label: 'Depuis'),
    gap(12), accountPicker(c, accounts, to, (v) => set(() => to = v), label: 'Vers'),
    gap(12), AmountField(controller: amount),
    gap(12), TextFormField(controller: fee, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Frais', suffixText: 'FCFA')),
    gap(14),
    FilledButton(onPressed: () async {
      if (!form.currentState!.validate()) return;
      final r = await run(c, () => app.api.post('/accounts/transfers', {'fromAccountId': from, 'toAccountId': to, 'amountMinor': parseAmountInput(amount.text), 'feeMinor': fee.text.replaceAll(RegExp(r'\s'), '').isEmpty ? '0' : fee.text.replaceAll(RegExp(r'\s'), '')}, true), success: 'Transfert enregistré');
      if (r != null && c.mounted) { Navigator.pop(c); app.bump(); }
    }, child: const Text('Enregistrer le transfert')),
  ]))));
}

class AccountDetailScreen extends StatelessWidget {
  final String id;
  const AccountDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<List>(load: (a) async => [await a.api.get('/accounts/$id'), await a.api.get('/activity', query: {'accountId': id, 'limit': '50'})], page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, d, _) {
    final a = d[0] as Map;
    final p = c.pal;
    return PageScaffold(title: a['name'], subtitle: accountTypeFr[a['type']], back: true, children: [
      AppCard(gradient: p.heroGradient, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Text('Solde du registre', style: inter(14, color: Colors.white70)), const Spacer(), DataLabel(a['dataLabel'], onDark: true)]),
        Money(a['balanceMinor'], size: 34, display: true, color: Colors.white),
        gap(6), Text('Vérification : ${{'USER_DECLARED': 'déclaré par vous', 'PROVIDER_VERIFIED': 'attesté par le prestataire', 'STALE': 'ancien — à revérifier', 'DOCUMENT_VERIFIED': 'justifié par document'}[a['verificationLevel']] ?? a['verificationLevel']} · dernière vérification ${fmtDateTime(a['lastVerifiedAt'])}', style: inter(12.5, color: Colors.white70)),
        if (a['blockedReason'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Sorties bloquées : ${a['blockedReason']}', style: inter(13, w: FontWeight.w600, color: const Color(0xFFFFC1BC)))),
      ])),
      gap(),
      Wrap(spacing: 10, runSpacing: 10, children: [
        FilledButton.tonalIcon(onPressed: () => openExpenseForm(c, accountId: id), icon: const Icon(Icons.shopping_bag_outlined), label: const Text('Dépense')),
        FilledButton.tonalIcon(onPressed: () => _declare(c, a), icon: const Icon(Icons.fact_check_outlined), label: const Text('Déclarer le solde observé')),
        if (a['openReconciliationCaseId'] != null) FilledButton.icon(onPressed: () => c.push('/activity/reconciliation/${a['openReconciliationCaseId']}'), icon: const Icon(Icons.compare_arrows_rounded), label: const Text('Écart à expliquer')),
      ]),
      gap(),
      const SectionTitle('Mouvements'),
      AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: (d[1]['items'] as List).isEmpty ? Padding(padding: const EdgeInsets.all(16), child: Text('Aucun mouvement.', style: inter(14, color: p.inkMuted))) : Column(children: [for (final i in d[1]['items']) activityRow(c, i)])),
    ]);
  });
  void _declare(BuildContext c, Map a) {
    final ctl = TextEditingController();
    openSheet(c, title: 'Solde observé', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const InfoBanner('Saisissez le solde affiché par votre banque ou opérateur. Un écart ouvre un cas de rapprochement : rien n’est aligné silencieusement.'),
      gap(12), TextField(controller: ctl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Solde observé', suffixText: 'FCFA')),
      gap(14), FilledButton(onPressed: () async {
        final r = await run(s, () => s.appRead.api.post('/accounts/${a['id']}/balance-declarations', {'observedMinor': ctl.text.replaceAll(RegExp(r'\s'), '')}));
        if (r != null && s.mounted) { Navigator.pop(s); s.appRead.bump(); toast(s, r['matched'] == true ? 'Solde concordant ✓' : 'Écart détecté : cas de rapprochement ouvert', error: r['matched'] != true); }
      }, child: const Text('Comparer')),
    ]));
  }
}

class IncomeDetailScreen extends StatelessWidget {
  final String id;
  const IncomeDetailScreen({super.key, required this.id});
  @override
  Widget build(BuildContext context) => Loader<Map>(load: (a) async => (await a.api.get('/incomes/$id')) as Map, page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, i, _) => PageScaffold(title: i['source'], subtitle: 'Revenu du ${fmtDate(i['economicDate'])}', back: true, children: [
    AppCard(child: Column(children: [KeyValue('Montant', Money(i['grossMinor'])), KeyValue('Statut', StatePill(i['recordingStatus'] == 'ALLOCATED' ? 'CONFIRMED' : 'PENDING')), KeyValue('Cycle', Text(i['cycleId'] == null ? 'Hors cycle' : 'Rattaché')), for (final a in i['allocations']) KeyValue('Affecté', Money(a['amountMinor']))])),
    if (i['recordingStatus'] != 'ALLOCATED') ...[gap(), FilledButton(onPressed: () => openIncomeWizard(c, existing: i), child: const Text('Répartir ce revenu'))],
  ]));
}
