import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/components.dart';
import '../../design/motion.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';
import 'money.dart';

class PaymentsTab extends StatelessWidget {
  const PaymentsTab({super.key});
  @override
  Widget build(BuildContext context) => TabBody(children: [
    Loader<List>(load: (a) async => [await a.api.get('/payments/capabilities'), await a.api.get('/security/limits'), await a.api.get('/beneficiaries'), await a.api.get('/payments/intents')], builder: (c, d, _) {
      final caps = d[0] as Map, lim = d[1] as Map, bens = d[2] as List, intents = d[3] as List;
      final p = c.pal;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (caps['provider'] != 'fake' && caps['provider'] != 'none') ...[_ProviderCard(caps: caps), gap(12)],
        gap(12),
        AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Text('Plafonds', style: sora(16, color: p.ink)), const Spacer(), TextButton(onPressed: () => c.push('/security/limits'), child: const Text('Gérer'))]),
          KeyValue('Par opération (frais inclus)', Money(lim['perOperationMinor'])),
          KeyValue('Sur 24 h glissantes', Money(lim['rolling24hMinor'])),
          gap(6), ProgressBar(ratio(lim['usedInWindowMinor'], lim['rolling24hMinor']), color: p.copper),
          gap(6), Row(children: [Text('Utilisé : ', style: inter(13, color: p.inkMuted)), Money(lim['usedInWindowMinor'], size: 13), const Spacer(), Text('Reste : ', style: inter(13, color: p.inkMuted)), Money(lim['remainingInWindowMinor'], size: 13)]),
        ])),
        gap(),
        FilledButton.icon(onPressed: bens.isEmpty ? () => openBeneficiaryForm(c) : () => openPayoutFlow(c), icon: const Icon(Icons.north_east_rounded), label: Text(bens.isEmpty ? 'Ajouter un bénéficiaire' : 'Nouveau paiement')),
        gap(),
        SectionTitle('Bénéficiaires', trailing: TextButton.icon(onPressed: () => openBeneficiaryForm(c), icon: const Icon(Icons.person_add_alt_rounded), label: const Text('Ajouter'))),
        if (bens.isNotEmpty) AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final b in bens) ListRow(leading: IconBadge(b['isOwnAccount'] ? Icons.person_rounded : Icons.person_outline_rounded), title: b['displayName'], subtitle: '${b['phoneE164']} · ${_opLabels[b['operator']] ?? b['operator']}', trailing: b['officialVerificationAt'] != null ? const Pill('Nom officiel vérifié', icon: Icons.verified_rounded) : Pill('Nom non vérifié', color: p.warning, icon: Icons.help_outline_rounded))])),
        gap(),
        const SectionTitle('Paiements'),
        if (intents.isEmpty) Text('Aucun paiement.', style: inter(14, color: p.inkMuted))
        else AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final i in intents) ListRow(leading: IconBadge(i['direction'] == 'PAYOUT' ? Icons.north_east_rounded : Icons.south_west_rounded, color: stateColor(c, i['state'])), title: i['direction'] == 'PAYOUT' ? 'Paiement sortant' : 'Dépôt', subtitle: fmtDateTime(i['createdAt']), trailing: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Money(i['totalDebitMinor'], size: 14), StatePill(i['state'])]), onTap: () => c.push('/money/payments/${i['id']}'))])),
      ]);
    }),
  ]);
}

/// Motifs de non-exécution, en clair.
String reasonLabel(String? r) => switch (r) {
  'NO_CONTROLLED_PSP_ACCOUNT' => 'Reliez d’abord votre compte Mobile Money',
  null => '',
  _ => 'Les paiements sont momentanément indisponibles',
};

const _opLabels = {'MTN_BJ': 'MTN Bénin', 'MOOV_BJ': 'Moov Africa Bénin', 'CELTIIS_BJ': 'Celtiis'};

/// Prestataire réel (FeexPay) : mode, exécutabilité, liaison du compte et solde par réseau (lecture seule).
class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.caps});
  final Map caps;
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final name = caps['provider'] == 'feexpay' ? 'FeexPay' : '${caps['provider']}';
    return AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        IconBadge(Icons.account_balance_wallet_outlined),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, style: sora(16, color: p.ink)),
          Text('Mobile Money — MTN, Moov, Celtiis', style: inter(13, color: p.inkMuted)),
        ])),
        caps['executable'] == true ? const Pill('Paiements actifs', icon: Icons.check_circle_rounded) : Pill('Paiements bloqués', color: p.warning, icon: Icons.lock_outline_rounded),
      ]),
      if (caps['executable'] != true) ...[gap(8), Text(reasonLabel(caps['nonExecutableReason']), style: inter(13, color: p.inkMuted))],
      gap(12),
      Loader<List>(load: (a) async {
        final accounts = (await a.api.get('/accounts')) as List;
        final linked = accounts.where((x) => x['type'] == 'CONTROLLED_PSP' && x['providerAccountId'] != null).toList();
        Object? bal;
        try { bal = await a.api.get('/payments/provider/balance'); } catch (e) { bal = e.toString(); }
        return [linked, bal];
      }, builder: (c, d, _) {
        final linked = d[0] as List; final bal = d[1];
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (bal is Map) ...[
            for (final e in (bal['channels'] as Map).entries) KeyValue('Solde ${_opLabels[e.key] ?? e.key}', Money(e.value)),
            KeyValue('Total chez $name', Money(bal['totalMinor'])),
            Text('Le solde est tenu par réseau : un paiement MTN exige du solde sur le canal MTN.', style: inter(12, color: p.inkMuted)),
          ] else Text('Solde $name momentanément indisponible', style: inter(13, color: p.warning)),
          gap(10),
          if (linked.isEmpty) FilledButton.tonalIcon(onPressed: () async {
            await run(c, () => c.appRead.api.post('/payments/provider/connect', {}), success: 'Compte $name relié');
            if (c.mounted) c.appRead.bump();
          }, icon: const Icon(Icons.link_rounded), label: Text('Relier mon compte $name'))
          else Row(children: [Icon(Icons.link_rounded, size: 18, color: p.success), const SizedBox(width: 6), Expanded(child: Text('Compte relié : ${linked.first['name']}', style: inter(13, color: p.ink)))]),
        ]);
      }),
    ]));
  }
}

Future<void> openBeneficiaryForm(BuildContext context) {
  final name = TextEditingController(), phone = TextEditingController(text: '+229');
  var op = 'MTN_BJ'; var own = false;
  return openSheet(context, title: 'Nouveau bénéficiaire', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    const InfoBanner('Le nom saisi est votre libellé de contact : ce n’est pas une vérification d’identité officielle.'),
    gap(12), TextField(controller: name, decoration: const InputDecoration(labelText: 'Nom du contact')),
    gap(12), TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Téléphone (format international)')),
    gap(12), DropdownButtonFormField(initialValue: op, decoration: const InputDecoration(labelText: 'Opérateur'), items: const [DropdownMenuItem(value: 'MTN_BJ', child: Text('MTN Bénin')), DropdownMenuItem(value: 'MOOV_BJ', child: Text('Moov Africa Bénin')), DropdownMenuItem(value: 'CELTIIS_BJ', child: Text('Celtiis'))], onChanged: (v) => set(() => op = v!)),
    SwitchListTile(contentPadding: EdgeInsets.zero, value: own, onChanged: (v) => set(() => own = v), title: const Text('C’est mon propre compte')),
    FilledButton(onPressed: () async {
      final api = c.appRead.api;
      final b = await run(c, () => api.post('/beneficiaries', {'displayName': name.text.trim(), 'phoneE164': phone.text.trim(), 'operator': op, 'isOwnAccount': own}));
      if (b != null) { final v = await run(c, () => api.post('/beneficiaries/${b['id']}/verify')); if (c.mounted) { toast(c, v?['message'] ?? 'Bénéficiaire ajouté'); Navigator.pop(c); c.appRead.bump(); } }
    }, child: const Text('Ajouter')),
  ])));
}

/// UX06 : parcours adaptatif ; récapitulatif + validation forte par opération TOUJOURS.
Future<void> openPayoutFlow(BuildContext context) async {
  final app = context.appRead;
  final bens = (await app.api.get('/beneficiaries')) as List;
  final wallets = (await app.api.get('/wallets')) as List;
  if (!context.mounted) return;
  if (!app.online) { toast(context, 'Aucun paiement hors ligne', error: true); return; }
  await openSheet(context, title: 'Nouveau paiement', (c) => _PayoutFlow(bens: bens, currentWalletId: wallets.firstWhere((w) => w['kind'] == 'CURRENT')['id']));
}
class _PayoutFlow extends StatefulWidget {
  final List bens; final String currentWalletId;
  const _PayoutFlow({required this.bens, required this.currentWalletId});
  @override
  State<_PayoutFlow> createState() => _PayoutFlowState();
}
class _PayoutFlowState extends State<_PayoutFlow> {
  String? ben; var mode = 'NET_RECEIVED';
  final amount = TextEditingController();
  Map? intent;
  bool ack = false, busy = false;
  String? error;
  late final key = DateTime.now().microsecondsSinceEpoch.toString();
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    if (intent == null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<String>(initialValue: ben, isExpanded: true, decoration: const InputDecoration(labelText: 'Bénéficiaire'), items: [for (final b in widget.bens) DropdownMenuItem(value: b['id'] as String, child: Text('${b['displayName']} · ${b['phoneE164']}'))], onChanged: (v) => setState(() => ben = v)),
        gap(12), SegmentedButton(segments: const [ButtonSegment(value: 'NET_RECEIVED', label: Text('Montant reçu')), ButtonSegment(value: 'TOTAL_DEBIT', label: Text('Total débité'))], selected: {mode}, onSelectionChanged: (s) => setState(() => mode = s.first)),
        gap(12), AmountField(controller: amount, helper: 'Source : portefeuille courant uniquement · plafonds frais inclus'),
        if (error != null) ...[gap(10), InfoBanner(error!, icon: Icons.error_outline_rounded, color: p.error)],
        gap(14), FilledButton(onPressed: busy || ben == null ? null : () async {
          final a = parseAmountInput(amount.text);
          if (a == null) return;
          setState(() { busy = true; error = null; });
          try { intent = await context.appRead.api.post('/payments/payouts/intents', {'sourceWalletId': widget.currentWalletId, 'beneficiaryId': ben, 'amountMode': mode, 'amountMinor': a, 'currency': 'XOF'}, true, 'payout-$key-$ben-$a-$mode'); } catch (e) { error = errText(e); }
          if (mounted) setState(() => busy = false);
        }, child: const Text('Voir le récapitulatif')),
      ]);
    }
    final i = intent!;
    final b = i['beneficiary'];
    final lim = i['limits'];
    final unverified = b['verification'] != 'OFFICIAL';
    final over = lim['wouldExceedPerOperation'] == true || lim['wouldExceedRolling'] == true;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(color: p.surfaceAlt, child: Column(children: [
        KeyValue('Bénéficiaire', Text(b['displayName'], style: inter(14.5, w: FontWeight.w700, color: p.ink))), KeyValue('Numéro', Text('${b['phoneE164']} · ${_opLabels[b['operator']] ?? b['operator']}')),
        const Divider(height: 18), KeyValue('Montant reçu', Money(i['amountNetMinor'])), KeyValue('Frais estimés', Money(i['feeQuoteMinor'])), KeyValue('Total débité', Money(i['totalDebitMinor'], size: 18, weight: FontWeight.w700)),
        KeyValue('Devis valable jusqu’à', Text(fmtDateTime(i['quoteExpiresAt']))),
      ])),
      gap(12),
      if (i['executable'] != true) InfoBanner('${reasonLabel(i['nonExecutableReason'])}. Ce paiement reste un brouillon et ne sera pas envoyé.', color: p.warning, icon: Icons.block_rounded),
      if (over && i['exception'] == null) ...[gap(8), InfoBanner('Ce paiement dépasse vos plafonds (30 000 F/opération, 60 000 F/24 h, frais inclus). Une dérogation unique peut être demandée : active après 72 h, valable 24 h, pour ce seul paiement.', color: p.warning, icon: Icons.speed_rounded, action: TextButton(onPressed: () async { await requestException(context, i); final fresh = await context.appRead.api.get('/payments/intents/${i['id']}'); if (mounted) setState(() => intent = fresh); }, child: const Text('Demander')))],
      if (over && i['exception'] != null) ...[gap(8), InfoBanner('Dérogation ${stateFr[i['exception']['effectiveState']]?.toLowerCase() ?? i['exception']['effectiveState']} : utilisable du ${fmtDateTime(i['exception']['activeFrom'])} au ${fmtDateTime(i['exception']['expiresAt'])}. Retrouvez ce paiement dans la liste pour le valider à ce moment-là.', color: p.info, icon: Icons.hourglass_top_rounded)],
      if (unverified) ...[gap(8), CheckboxListTile(contentPadding: EdgeInsets.zero, value: ack, onChanged: (v) => setState(() => ack = v!), title: Text('Je confirme que ${b['phoneE164']} est bien le bon destinataire', style: inter(14, w: FontWeight.w600, color: p.ink)), subtitle: const Text('Nom officiel non vérifiable chez le prestataire : contrôle renforcé.'))],
      if (error != null) ...[gap(10), InfoBanner(error!, icon: Icons.error_outline_rounded, color: p.error)],
      gap(14),
      FilledButton.icon(onPressed: busy || (unverified && !ack) || i['executable'] != true ? null : () async {
        setState(() { busy = true; error = null; });
        final app = context.appRead;
        try {
          final ch = await app.api.post('/payments/intents/${i['id']}/challenge');
          final approval = await app.key.signChallenge(ch);
          await app.api.post('/payments/intents/${i['id']}/authorize', {'approval': approval, 'acknowledgeUnverifiedBeneficiary': ack});
          await app.api.post('/payments/intents/${i['id']}/submit');
          if (mounted) { Navigator.pop(context); app.bump(); context.push('/money/payments/${i['id']}'); }
        } catch (e) { error = errText(e); }
        if (mounted) setState(() => busy = false);
      }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Valider avec cet appareil et envoyer')),
      TextButton(onPressed: () => setState(() => intent = null), child: const Text('Modifier')),
    ]);
  }
}

Future<void> requestException(BuildContext context, Map intent) async {
  final reason = TextEditingController();
  await openSheet(context, title: 'Dérogation pour grosse dépense', (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    const InfoBanner('Délai renforcé de 72 h, puis fenêtre d’utilisation de 24 h, usage unique, liée à ce paiement et ce bénéficiaire. Elle ne lève jamais une suspension de sécurité, un blocage de rapprochement ni les limites du prestataire.', icon: Icons.hourglass_top_rounded),
    gap(12), KeyValue('Montant maximal', Money(intent['totalDebitMinor'])),
    gap(8), TextField(controller: reason, decoration: const InputDecoration(labelText: 'Motif')),
    gap(14), FilledButton(onPressed: () async {
      final app = c.appRead;
      final params = {'paymentIntentId': intent['id'], 'maxDebitMinor': intent['totalDebitMinor'], 'reason': reason.text.trim()};
      final r = await run(c, () async => app.api.post('/security/exceptions', {...params, 'approval': await app.approve('exception.request', params)}), success: 'Dérogation demandée : active dans 72 h');
      if (r != null && c.mounted) Navigator.pop(c);
    }, child: const Text('Demander (validation forte)')),
  ]));
}

class PaymentDetailScreen extends StatelessWidget {
  final String id;
  const PaymentDetailScreen({super.key, required this.id});
  /// Reprise d'un paiement préparé (ex. après le délai d'une dérogation) : devis actualisé si expiré, confirmation renforcée et signature.
  Future<void> _resume(BuildContext c, Map i0) async {
    final app = c.appRead;
    var i = i0;
    if (i['quoteExpired'] == true) { final r = await run(c, () => app.api.post('/payments/intents/$id/requote')); if (r == null) return; i = r; }
    if (!c.mounted) return;
    var ack = false;
    await openSheet(c, title: 'Valider le paiement', (s) => StatefulBuilder(builder: (s, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      KeyValue('Bénéficiaire', Text('${i['beneficiary']['displayName']} · ${i['beneficiary']['phoneE164']}')), KeyValue('Total débité', Money(i['totalDebitMinor'], weight: FontWeight.w700)), KeyValue('Frais', Money(i['feeQuoteMinor'])),
      if (i['exception'] != null) KeyValue('Dérogation', StatePill(i['exception']['effectiveState'])),
      CheckboxListTile(contentPadding: EdgeInsets.zero, value: ack, onChanged: (v) => set(() => ack = v!), title: Text('Je confirme que ${i['beneficiary']['phoneE164']} est le bon destinataire')),
      gap(10), FilledButton.icon(onPressed: !ack ? null : () async {
        final r = await run(s, () async {
          final ch = await app.api.post('/payments/intents/$id/challenge');
          await app.api.post('/payments/intents/$id/authorize', {'approval': await app.key.signChallenge(ch), 'acknowledgeUnverifiedBeneficiary': true});
          return app.api.post('/payments/intents/$id/submit');
        });
        if (r != null && s.mounted) { Navigator.pop(s); app.bump(); }
      }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Valider avec cet appareil et envoyer')),
    ])));
  }
  @override
  Widget build(BuildContext context) => Loader<Map>(load: (a) async => await a.api.get('/payments/intents/$id'), page: true, loading: const Scaffold(body: Center(child: CircularProgressIndicator())), builder: (c, i, _) {
    final p = c.pal;
    final s = i['state'] as String;
    final ok = s == 'SUCCEEDED';
    return PageScaffold(title: i['direction'] == 'PAYOUT' ? 'Paiement' : 'Dépôt', back: true, children: [
      AppCard(child: Column(children: [
        // L'animation de réussite n'apparaît qu'après confirmation PSP (Annexe B).
        AnimatedSwitcher(duration: Motion.d(c, Motion.slow), child: Container(key: ValueKey(s), width: 84, height: 84, decoration: BoxDecoration(shape: BoxShape.circle, color: stateColor(c, s).withValues(alpha: .14)), child: Icon(ok ? Icons.check_rounded : s == 'UNKNOWN' ? Icons.help_outline_rounded : s == 'FAILED' || s == 'CANCELLED' ? Icons.close_rounded : Icons.hourglass_top_rounded, size: 42, color: stateColor(c, s)))),
        gap(12), StatePill(s), gap(8),
        Money(i['totalDebitMinor'], size: 30, display: true),
        if (i['beneficiary'] != null) Text('à ${i['beneficiary']['displayName']} · ${i['beneficiary']['phoneE164']}', style: inter(14, color: p.inkMuted)),
        if (s == 'UNKNOWN') ...[gap(12), InfoBanner('Résultat inconnu : le prestataire n’a pas confirmé. Ce n’est PAS un échec. Aucun nouvel essai ne sera fait automatiquement ; le montant et le plafond restent réservés jusqu’au rapprochement.', color: p.warning, icon: Icons.help_outline_rounded)],
        gap(12),
        Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
          if (['PROCESSING', 'UNKNOWN'].contains(s)) OutlinedButton.icon(onPressed: () async { await run(c, () => c.appRead.api.post('/payments/intents/$id/recheck'), success: 'Statut vérifié'); if (c.mounted) c.appRead.bump(); }, icon: const Icon(Icons.refresh_rounded), label: const Text('Vérifier le statut (lecture seule)')),
          if (['AWAITING_CONFIRMATION', 'RESERVED'].contains(s)) OutlinedButton.icon(onPressed: () async {
            if (!await confirmDanger(c, title: 'Annuler ce paiement ?', message: 'Possible uniquement avant toute transmission au prestataire. Les réservations seront libérées.', destructive: true)) return;
            if (!c.mounted) return;
            final app = c.appRead;
            await run(c, () async => app.api.post('/payments/intents/$id/cancel', {'approval': await app.approve('payment.cancel', {'intentId': id})}), success: 'Paiement annulé');
            app.bump();
          }, icon: const Icon(Icons.close_rounded), label: const Text('Annuler')),
          if (s == 'AWAITING_CONFIRMATION') FilledButton.icon(onPressed: () => _resume(c, i), icon: const Icon(Icons.fingerprint_rounded), label: const Text('Valider et envoyer')),
          if (s == 'RESERVED') FilledButton(onPressed: () async { await run(c, () => c.appRead.api.post('/payments/intents/$id/submit')); if (c.mounted) c.appRead.bump(); }, child: const Text('Transmettre')),
        ]),
      ])),
      gap(),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        KeyValue('Montant reçu', Money(i['amountNetMinor'])), KeyValue('Frais', Money(i['feeQuoteMinor'])), KeyValue('Réservation fonds', Text(stateFr[i['holds']['funds']] ?? '—')), KeyValue('Réservation plafond', Text(stateFr[i['holds']['limit']] ?? '—')),
        if (i['exception'] != null) KeyValue('Dérogation', StatePill(i['exception']['effectiveState'])),
      ])),
      gap(),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionTitle('Chronologie'),
        for (final h in (i['history'] as List)) Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Column(children: [Container(width: 12, height: 12, decoration: BoxDecoration(color: stateColor(c, h['to']), shape: BoxShape.circle)), Container(width: 2, height: 34, color: p.border)]),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(stateFr[h['to']] ?? h['to'], style: inter(14, w: FontWeight.w600, color: p.ink)), Text(fmtDateTime(h['at']), style: inter(12, color: p.inkMuted))])),
        ]),
      ])),
    ]);
  });
}
