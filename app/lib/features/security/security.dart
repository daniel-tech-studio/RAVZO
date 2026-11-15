import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/components.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';

const _st = ['overview', 'devices', 'limits', 'journal'];

/// UX15 : appareils, plafonds, sessions, dérogations, événements.
class SecurityScreen extends StatelessWidget {
  final String? initialTab;
  const SecurityScreen({super.key, this.initialTab});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 4, initialIndex: _st.indexOf(initialTab ?? 'overview').clamp(0, 3), child: PageScaffold(title: 'Centre de sécurité', back: true, showGlobalActions: false, children: [
    const TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [Tab(text: 'Vue d’ensemble'), Tab(text: 'Appareils & sessions'), Tab(text: 'Plafonds & dérogations'), Tab(text: 'Journal')]),
    SizedBox(height: MediaQuery.sizeOf(context).height - 200, child: const TabBarView(children: [_Overview(), _Devices(), _Limits(), _Journal()])),
  ]));
}

class _Overview extends StatelessWidget {
  const _Overview();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.only(top: 16), children: [Loader<Map>(load: (a) async => await a.api.get('/security/status'), builder: (c, s, _) {
    final p = c.pal;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(gradient: s['financialReadOnly'] == true ? null : p.heroGradient, color: s['financialReadOnly'] == true ? p.warning.withValues(alpha: .12) : null, child: Row(children: [
        Icon(s['financialReadOnly'] == true ? Icons.lock_clock_rounded : Icons.verified_user_rounded, size: 44, color: s['financialReadOnly'] == true ? p.warning : Colors.white), const SizedBox(width: 16),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(s['financialReadOnly'] == true ? 'Suspension de 48 h active' : 'Compte protégé', style: sora(19, color: s['financialReadOnly'] == true ? p.ink : Colors.white)), Text(s['financialReadOnly'] == true ? 'Modifications financières bloquées jusqu’au ${fmtDateTime(s['financialReadOnlyUntil'])} (horloge serveur). Consultation et révocations restent possibles.' : '${s['activeDevices']} appareil(s) de confiance · validation forte par opération', style: inter(13.5, color: s['financialReadOnly'] == true ? p.inkSoft : Colors.white70))])),
      ])),
      gap(),
      AppCard(child: Column(children: [
        KeyValue('Cet appareil', StatePill(s['deviceTrusted'] == true ? 'ACTIVE' : 'PENDING')),
        KeyValue('Codes de secours restants', Text('${s['remainingRecoveryCodes']} / 10', style: inter(14, w: FontWeight.w700, color: s['remainingRecoveryCodes'] < 3 ? p.error : p.ink))),
        KeyValue('Paiements réels', Text(s['paymentsLiveEnabled'] == true ? 'Activés' : 'Désactivés')),
        KeyValue('Heure serveur', Text(fmtDateTime(s['serverTime']))),
      ])),
      gap(),
      OutlinedButton.icon(onPressed: () => _regen(c), icon: const Icon(Icons.password_rounded), label: const Text('Régénérer les codes de secours')),
    ]);
  })]);
  void _regen(BuildContext c) async {
    if (!await confirmDanger(c, title: 'Régénérer les codes ?', message: 'Les anciens codes seront invalidés. Les nouveaux ne seront affichés qu’une seule fois : conservez-les hors ligne.')) return;
    if (!c.mounted) return;
    final app = c.appRead;
    final r = await run(c, () async => app.api.post('/recovery/codes/regenerate', {'approval': await app.approve('recovery.regenerate', {})}));
    if (r == null || !c.mounted) return;
    openSheet(c, title: 'Nouveaux codes de secours', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const InfoBanner('Affichés une seule fois. Notez-les sur papier et rangez-les en lieu sûr.', icon: Icons.warning_amber_rounded), gap(12), SelectableText((r['recoveryCodes'] as List).asMap().entries.map((e) => '${e.key + 1}. ${e.value}').join('\n'), style: inter(16, w: FontWeight.w600, tab: true, color: s.pal.ink, height: 1.7))]));
  }
}

class _Devices extends StatelessWidget {
  const _Devices();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.only(top: 16), children: [Loader<List>(load: (a) async => [await a.api.get('/devices'), await a.api.get('/sessions'), await a.api.get('/devices/enrollment-requests')], builder: (c, d, _) {
    final devices = d[0] as List, sessions = d[1] as List, pending = d[2] as List;
    final p = c.pal;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (pending.isNotEmpty) ...[AppCard(color: p.warning.withValues(alpha: .08), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Appareil en attente d’approbation', style: sora(16, color: p.ink)), gap(6), Text('N’approuvez que si vous êtes à l’origine de la demande. Saisissez le code affiché sur le nouvel appareil.', style: inter(13, color: p.inkSoft)),
        for (final r in pending) ListRow(leading: IconBadge(Icons.phonelink_lock_rounded, color: p.warning), title: r['candidate']?['name'] ?? 'Appareil', subtitle: '${r['candidate']?['platform']} · expire ${fmtDateTime(r['expiresAt'])}', trailing: FilledButton(onPressed: () => _approve(c, r['id']), child: const Text('Approuver'))),
      ])), gap()],
      const SectionTitle('Appareils'),
      AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final dv in devices) ListRow(leading: IconBadge(dv['platform'] == 'macos' ? Icons.laptop_mac_rounded : dv['platform'] == 'ios' ? Icons.phone_iphone_rounded : Icons.phone_android_rounded, color: stateColor(c, dv['status'])), title: '${dv['name']}${dv['isCurrent'] ? ' (cet appareil)' : ''}', subtitle: 'Vu ${relative(dv['lastSeenAt'])} · ajouté ${fmtDate(dv['createdAt'])}', trailing: Row(mainAxisSize: MainAxisSize.min, children: [StatePill(dv['status']), if (dv['status'] != 'REVOKED' && !dv['isCurrent']) IconButton(tooltip: 'Révoquer', onPressed: () => _revoke(c, dv), icon: Icon(Icons.block_rounded, color: p.error))]))])),
      gap(),
      const SectionTitle('Sessions actives'),
      AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final s in sessions) ListRow(leading: const IconBadge(Icons.key_rounded, size: 36), title: '${s['device']?['name'] ?? 'Session'}${s['isCurrent'] ? ' · actuelle' : ''}', subtitle: 'Ouverte ${fmtDateTime(s['issuedAt'])}', trailing: s['isCurrent'] ? null : IconButton(tooltip: 'Fermer cette session', onPressed: () async { final app = c.appRead; await run(c, () async => app.api.delete('/sessions/${s['id']}', {'approval': await app.approve('session.revoke', {'sessionId': s['id']})}), success: 'Session révoquée'); app.bump(); }, icon: const Icon(Icons.logout_rounded)))])),
    ]);
  })]);
  void _approve(BuildContext c, String id) { final code = TextEditingController(); openSheet(c, title: 'Approuver l’appareil', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [TextField(controller: code, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Code affiché sur le nouvel appareil')), gap(14), FilledButton.icon(onPressed: () async { final app = s.appRead; final r = await run(s, () async => app.api.post('/devices/enrollment-requests/$id/approve', {'code': code.text.replaceAll(' ', ''), 'approval': await app.approve('device.approve', {'requestId': id})}), success: 'Appareil approuvé'); if (r != null && s.mounted) { Navigator.pop(s); app.bump(); } }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Approuver (validation forte)'))])); }
  void _revoke(BuildContext c, Map d) async {
    if (!await confirmDanger(c, title: 'Révoquer « ${d['name']} » ?', message: 'L’accès serveur est coupé immédiatement. Le cache d’un appareil perdu et hors ligne ne peut pas être effacé à distance.', confirm: 'Révoquer', destructive: true)) return;
    if (!c.mounted) return;
    final app = c.appRead;
    await run(c, () async => app.api.post('/devices/${d['id']}/revoke', {'approval': await app.approve('device.revoke', {'deviceId': d['id']})}), success: 'Appareil révoqué');
    app.bump();
  }
}

class _Limits extends StatelessWidget {
  const _Limits();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.only(top: 16), children: [Loader<List>(load: (a) async => [await a.api.get('/security/limits'), await a.api.get('/security/exceptions')], builder: (c, d, _) {
    final l = d[0] as Map, ex = d[1] as List;
    final p = c.pal;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Plafonds actifs (v${l['policyVersion']})', style: sora(16, color: p.ink)), gap(8),
        KeyValue('Par opération', Money(l['perOperationMinor'])), KeyValue('Sur 24 h glissantes', Money(l['rolling24hMinor'])), KeyValue('Utilisé dans la fenêtre', Money(l['usedInWindowMinor'])), KeyValue('Références', Text('${money(l['referencePerOperationMinor'], hidden: c.app.hideAmounts)} / ${money(l['referenceRolling24hMinor'], hidden: c.app.hideAmounts)}')),
        if (l['nextCapacityReleaseAt'] != null) KeyValue('Prochaine libération', Text(fmtDateTime(l['nextCapacityReleaseAt']))),
        gap(6), Text(l['scope'], style: inter(12.5, color: p.inkMuted)),
        gap(10), FilledButton.tonal(onPressed: () => _change(c, l), child: const Text('Modifier les plafonds')),
      ])),
      for (final pc in l['pendingChanges']) Padding(padding: const EdgeInsets.only(top: 12), child: InfoBanner('Hausse en attente → ${money(pc['proposedPerOperation'], hidden: c.app.hideAmounts)} / ${money(pc['proposedRolling24h'], hidden: c.app.hideAmounts)}, effective le ${fmtDateTime(pc['effectiveAt'])}.', icon: Icons.hourglass_top_rounded, action: TextButton(onPressed: () async { await run(c, () => c.appRead.api.post('/security/limit-changes/${pc['id']}/cancel'), success: 'Demande annulée'); c.appRead.bump(); }, child: const Text('Annuler')))),
      gap(),
      const SectionTitle('Dérogations', subtitle: 'Usage unique · active après 72 h · valable 24 h'),
      if (ex.isEmpty) Text('Aucune dérogation. Elles se demandent depuis un paiement qui dépasse vos plafonds.', style: inter(13.5, color: p.inkMuted)),
      for (final e in ex) Padding(padding: const EdgeInsets.only(bottom: 10), child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [Expanded(child: Text(e['reason'], style: inter(14.5, w: FontWeight.w600, color: p.ink))), StatePill(e['effectiveState'])]),
        KeyValue('Maximum', Money(e['maxDebitMinor'])), KeyValue('Active à partir de', Text(fmtDateTime(e['activeFrom']))), KeyValue('Expire', Text(fmtDateTime(e['expiresAt']))),
        if (['WAITING', 'ACTIVE'].contains(e['effectiveState'])) Align(alignment: Alignment.centerRight, child: TextButton(onPressed: () async { final app = c.appRead; await run(c, () async => app.api.post('/security/exceptions/${e['id']}/cancel', {'approval': await app.approve('exception.cancel', {'exceptionId': e['id']})}), success: 'Dérogation révoquée'); app.bump(); }, child: const Text('Révoquer'))),
      ]))),
    ]);
  })]);
  void _change(BuildContext c, Map l) {
    final op = TextEditingController(text: l['perOperationMinor']), roll = TextEditingController(text: l['rolling24hMinor']);
    openSheet(c, title: 'Modifier les plafonds', (s) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const InfoBanner('Baisse : immédiate. Hausse dans les références : effective après 48 h. Hausse au-delà des références : 72 h. Une demande en attente n’efface pas les réservations existantes.', icon: Icons.schedule_rounded),
      gap(12), AmountField(controller: op, label: 'Par opération (frais inclus)'), gap(12), AmountField(controller: roll, label: 'Sur 24 h glissantes'),
      gap(14), FilledButton.icon(onPressed: () async {
        final app = s.appRead; final a = parseAmountInput(op.text), b = parseAmountInput(roll.text);
        if (a == null || b == null) return;
        final r = await run(s, () async => app.api.post('/security/limit-changes', {'perOperationMinor': a, 'rolling24hMinor': b, 'approval': await app.approve('limits.change', {'perOperationMinor': a, 'rolling24hMinor': b})}));
        if (r != null && s.mounted) { Navigator.pop(s); app.bump(); toast(s, r['kind'] == 'DECREASE' ? 'Baisse appliquée immédiatement' : 'Hausse programmée le ${fmtDateTime(r['effectiveAt'])}'); }
      }, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Demander (validation forte)')),
    ]));
  }
}

class _Journal extends StatefulWidget {
  const _Journal();
  @override
  State<_Journal> createState() => _JournalState();
}
class _JournalState extends State<_Journal> {
  final items = <Map>[]; String? cursor; bool more = true, busy = false;
  @override
  void initState() { super.initState(); WidgetsBinding.instance.addPostFrameCallback((_) => load()); }
  Future<void> load() async {
    if (busy || !more) return;
    setState(() => busy = true);
    try { final d = await context.appRead.api.get('/security/events', query: {'cursor': cursor, 'limit': '50'}); items.addAll((d['items'] as List).cast<Map>()); cursor = d['nextCursor']; more = d['hasMore'] == true; } catch (_) {}
    if (mounted) setState(() => busy = false);
  }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return NotificationListener<ScrollNotification>(onNotification: (n) { if (n.metrics.pixels > n.metrics.maxScrollExtent - 300) load(); return false; }, child: ListView(padding: const EdgeInsets.only(top: 16), children: [
      Text('Journal append-only : il ne contient ni secret, ni signature réutilisable.', style: inter(12.5, color: p.inkMuted)), gap(10),
      AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final e in items) ListRow(leading: IconBadge(Icons.shield_moon_outlined, size: 34, color: e['decision'] == 'DENIED' || '${e['decision']}'.contains('INVALID') ? p.error : p.primary), title: e['type'], subtitle: '${fmtDateTime(e['at'])} · ${e['decision']}')])),
      if (busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
    ]));
  }
}
