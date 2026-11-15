import 'dart:async';
import 'dart:convert';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../core/app_state.dart';
import '../../core/format.dart';
import '../../design/components.dart';
import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../shell.dart';

const _catIcon = {'SECURITY': Icons.shield_rounded, 'PAYMENT': Icons.payments_rounded, 'RECONCILIATION': Icons.compare_arrows_rounded, 'SAVINGS': Icons.savings_rounded, 'BUDGET': Icons.donut_large_rounded, 'LIABILITY': Icons.handshake_rounded, 'MARKET': Icons.candlestick_chart_rounded, 'SYSTEM': Icons.info_rounded};

/// UX14 : notifications intelligentes, critiques jamais masquées.
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});
  @override
  Widget build(BuildContext context) => PageScaffold(title: 'Notifications', back: true, showGlobalActions: false, actions: [
    TextButton(onPressed: () async { await run(context, () => context.appRead.api.post('/notifications/read-all')); if (context.mounted) { context.appRead.bump(); context.appRead.refreshBadges(); } }, child: const Text('Tout lire')),
    IconButton(tooltip: 'Préférences', onPressed: () => _prefs(context), icon: const Icon(Icons.tune_rounded)),
  ], children: [Loader<Map>(load: (a) async => await a.api.get('/notifications'), builder: (c, d, _) {
    final items = d['items'] as List;
    final p = c.pal;
    if (items.isEmpty) return const AppCard(child: EmptyState(icon: Icons.notifications_none_rounded, title: 'Tout est calme', message: 'Les événements de sécurité, paiements, écarts et échéances apparaîtront ici.'));
    return Column(children: [for (final n in items) Padding(padding: const EdgeInsets.only(bottom: 10), child: AppCard(onTap: () async { await c.appRead.api.post('/notifications/${n['id']}/read'); c.appRead.refreshBadges(); if (c.mounted) goLink(c, n['link']); }, color: n['readAt'] == null ? (n['priority'] == 'CRITICAL' ? p.error.withValues(alpha: .06) : p.surface) : p.surface.withValues(alpha: .6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      IconBadge(_catIcon[n['category']] ?? Icons.notifications_rounded, color: n['priority'] == 'CRITICAL' ? p.error : n['priority'] == 'HIGH' ? p.warning : p.primary), const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Expanded(child: Text(n['title'], style: inter(15, w: n['readAt'] == null ? FontWeight.w700 : FontWeight.w500, color: p.ink))), if (n['readAt'] == null) Container(width: 8, height: 8, decoration: BoxDecoration(color: n['priority'] == 'CRITICAL' ? p.error : p.copper, shape: BoxShape.circle))]),
        const SizedBox(height: 3), Text(n['body'], style: inter(13.5, color: p.inkSoft, height: 1.4)),
        const SizedBox(height: 6), Text('${relative(n['createdAt'])} · push ${(n['deliveries'] as List).firstWhere((x) => x['channel'] == 'PUSH', orElse: () => {'status': '—'})['status'] == 'NOT_CONFIGURED' ? 'non configuré' : 'envoyé'}', style: inter(11.5, color: p.inkMuted)),
      ])),
    ])))]);
  })]);
  void _prefs(BuildContext context) async {
    final d = await context.appRead.api.get('/notifications');
    if (!context.mounted) return;
    final muted = Set<String>.from(d['mutedCategories']);
    await openSheet(context, title: 'Préférences de notification', (c) => StatefulBuilder(builder: (c, set) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const InfoBanner('Sécurité, paiements et écarts de solde ne peuvent jamais être masqués. Les montants ne sont pas affichés sur écran verrouillé.', icon: Icons.lock_rounded),
      for (final k in ['BUDGET', 'SAVINGS', 'MARKET', 'LIABILITY', 'SYSTEM']) SwitchListTile(value: !muted.contains(k), onChanged: (v) => set(() => v ? muted.remove(k) : muted.add(k)), title: Text({'BUDGET': 'Budgets', 'SAVINGS': 'Épargne', 'MARKET': 'Marché', 'LIABILITY': 'Dettes', 'SYSTEM': 'Système'}[k]!), subtitle: const Text('Les alertes importantes restent visibles')),
      FilledButton(onPressed: () async { await run(c, () => c.appRead.api.post('/notifications/preferences', {'mutedCategories': muted.toList(), 'hideAmountsOnLockScreen': true}), success: 'Préférences enregistrées'); if (c.mounted) { Navigator.pop(c); c.appRead.bump(); } }, child: const Text('Enregistrer')),
    ])));
  }
}

/// UX21/UX24 : centre des opérations commun — jamais de « réessayer » aveugle.
class OperationsScreen extends StatelessWidget {
  const OperationsScreen({super.key});
  @override
  Widget build(BuildContext context) => PageScaffold(title: 'Centre des opérations', subtitle: 'En attente, brouillons, incertain, interventions', back: true, showGlobalActions: false, children: [Loader<Map>(load: (a) async => await a.api.get('/operations'), builder: (c, d, _) {
    final items = d['items'] as List;
    final drafts = c.app.localDrafts;
    final p = c.pal;
    if (items.isEmpty && drafts.isEmpty) return const AppCard(child: EmptyState(icon: Icons.task_alt_rounded, title: 'Rien en attente', message: 'Aucune opération ne requiert votre attention.'));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (drafts.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 12), child: InfoBanner('${drafts.length} brouillon(s) hors ligne sur cet appareil à présenter pour confirmation.', icon: Icons.cloud_upload_outlined, action: TextButton(onPressed: () => c.push('/sync'), child: const Text('Ouvrir')))),
      for (final i in items) Padding(padding: const EdgeInsets.only(bottom: 10), child: AppCard(onTap: () => goLink(c, i['link']), child: Row(children: [
        IconBadge(switch (i['kind']) { 'PAYMENT' => Icons.payments_outlined, 'RECONCILIATION' => Icons.compare_arrows_rounded, 'OFFLINE_DRAFT' => Icons.edit_note_rounded, 'SAVINGS_WITHDRAWAL' => Icons.lock_open_rounded, 'IMPORT' => Icons.upload_file_rounded, 'DEVICE_ENROLLMENT' => Icons.phonelink_lock_rounded, _ => Icons.flag_outlined }, color: i['urgency'] == 'CRITICAL' ? p.error : i['urgency'] == 'HIGH' ? p.warning : p.primary),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(i['title'], style: inter(15, w: FontWeight.w600, color: p.ink)), if (i['eligibleAt'] != null) Text('Confirmable ${fmtDateTime(i['eligibleAt'])}', style: inter(12.5, color: p.inkMuted)), if (i['effectiveAt'] != null) Text('Effectif ${fmtDateTime(i['effectiveAt'])}', style: inter(12.5, color: p.inkMuted)), if (i['dueDate'] != null) Text('Échéance ${fmtDate(i['dueDate'])}', style: inter(12.5, color: p.inkMuted))])),
        StatePill(i['state']), const Icon(Icons.chevron_right_rounded),
      ]))),
    ]);
  })]);
}

/// UX19 : recherche globale.
class SearchScreen extends StatefulWidget {
  final String? initial;
  const SearchScreen({super.key, this.initial});
  @override
  State<SearchScreen> createState() => _SearchScreenState();
}
class _SearchScreenState extends State<SearchScreen> {
  late final ctl = TextEditingController(text: widget.initial);
  Timer? deb; List results = []; bool busy = false;
  static const icons = {'ACCOUNT': Icons.account_balance_outlined, 'EXPENSE': Icons.shopping_bag_outlined, 'INCOME': Icons.south_west_rounded, 'SAVINGS_GOAL': Icons.savings_outlined, 'LIABILITY': Icons.handshake_outlined, 'SECURITY': Icons.candlestick_chart_rounded, 'BENEFICIARY': Icons.person_outline_rounded, 'ASSET': Icons.home_work_outlined};
  void search(String q) { deb?.cancel(); deb = Timer(const Duration(milliseconds: 280), () async { if (q.trim().length < 2) { setState(() => results = []); return; } setState(() => busy = true); try { final d = await context.appRead.api.get('/search', query: {'q': q}); results = d['results']; } catch (_) {} if (mounted) setState(() => busy = false); }); }
  @override
  void initState() { super.initState(); if (widget.initial != null) search(widget.initial!); }
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return PageScaffold(title: 'Recherche', back: true, showGlobalActions: false, children: [
      TextField(controller: ctl, autofocus: true, onChanged: search, style: inter(17, color: p.ink), decoration: InputDecoration(prefixIcon: const Icon(Icons.search_rounded), hintText: 'Libellé, montant, compte, coffre, titre, bénéficiaire…', suffixIcon: busy ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))) : null)),
      gap(),
      if (results.isEmpty && ctl.text.length >= 2 && !busy) Text('Aucun résultat.', style: inter(14, color: p.inkMuted)),
      if (results.isNotEmpty) AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final r in results) ListRow(leading: IconBadge(icons[r['type']] ?? Icons.label_outline), title: r['title'], subtitle: r['subtitle'], trailing: r['amountMinor'] != null ? Money(r['amountMinor'], size: 14) : const Icon(Icons.chevron_right_rounded), onTap: () => goLink(context, r['link']))])),
    ]);
  }
}

/// UX17 / D44 : centre de synchronisation — validation INDIVIDUELLE de chaque modification hors ligne.
class SyncCenterScreen extends StatelessWidget {
  const SyncCenterScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final p = context.pal;
    final local = app.localDrafts;
    return PageScaffold(title: 'Synchronisation', subtitle: app.lastSync == null ? 'Jamais synchronisé' : 'Dernière actualisation ${fmtDateTime(app.lastSync!.toUtc().toIso8601String())}', back: true, showGlobalActions: false, children: [
      AppCard(child: Row(children: [Icon(app.online ? (app.streamConnected ? Icons.cloud_done_rounded : Icons.cloud_sync_rounded) : Icons.cloud_off_rounded, color: app.online ? p.success : p.warning, size: 30), const SizedBox(width: 12), Expanded(child: Text(app.online ? (app.streamConnected ? 'En ligne · temps réel actif' : 'En ligne · reconnexion du flux…') : 'Hors ligne : lecture du cache chiffré, saisies en brouillon', style: inter(14.5, w: FontWeight.w600, color: p.ink))), TextButton(onPressed: () => app.catchUp(), child: const Text('Actualiser'))])),
      gap(),
      if (local.isNotEmpty) ...[
        SectionTitle('Sur cet appareil', subtitle: '${local.length} brouillon(s) à présenter au serveur (rien n’est appliqué à cette étape)'),
        AppCard(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6), child: Column(children: [for (final d in local) ListRow(leading: const IconBadge(Icons.edit_note_rounded), title: '${d['targetResource'] == 'EXPENSE' ? 'Dépense' : d['targetResource']} · ${d['payload']['label'] ?? ''}', subtitle: 'Créé ${fmtDateTime(d['createdAt'])}', trailing: Row(mainAxisSize: MainAxisSize.min, children: [if (d['payload']['amountMinor'] != null) Money(d['payload']['amountMinor'], size: 13.5), IconButton(tooltip: 'Abandonner', onPressed: () => app.removeLocalDraft(d['clientDraftId']), icon: const Icon(Icons.delete_outline_rounded))]))])),
        gap(10),
        FilledButton.icon(onPressed: !app.online ? null : () async {
          final r = await run(context, () => app.api.post('/sync/drafts/prepare', {'drafts': [for (final d in local) {'clientDraftId': d['clientDraftId'], 'targetResource': d['targetResource'], 'operation': d['operation'], if (d['targetId'] != null) 'targetId': d['targetId'], if (d['baseVersion'] != null) 'baseVersion': d['baseVersion'], 'payload': d['payload']}]}), success: 'Brouillons présentés : confirmez-les un par un');
          if (r != null) { for (final d in local) { await app.removeLocalDraft(d['clientDraftId']); } app.bump(); }
        }, icon: const Icon(Icons.upload_rounded), label: const Text('Présenter au serveur pour validation')),
        gap(),
      ],
      const SectionTitle('À confirmer individuellement'),
      Loader<List>(load: (a) async => await a.api.get('/sync/drafts') as List, builder: (c, list, _) => list.isEmpty ? const AppCard(child: EmptyState(icon: Icons.done_all_rounded, title: 'Aucune modification en attente', message: 'Chaque modification préparée hors ligne vous sera présentée ici avant d’être appliquée.')) : Column(children: [for (final d in list) Padding(padding: const EdgeInsets.only(bottom: 10), child: _DraftCard(d: d))])),
    ]);
  }
}
class _DraftCard extends StatelessWidget {
  final Map d;
  const _DraftCard({required this.d});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final pl = d['payload'] as Map;
    final rejected = d['state'] == 'REJECTED';
    return AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Expanded(child: Text({'EXPENSE': 'Dépense', 'INCOME': 'Revenu', 'SAVINGS_GOAL_META': 'Modification de coffre', 'ASSET': 'Bien'}[d['targetResource']] ?? d['targetResource'], style: sora(15, color: p.ink))), StatePill(d['state'])]),
      gap(8),
      for (final e in pl.entries.where((e) => e.key != 'accountId' && e.key != 'categoryId')) KeyValue(e.key, Text('${e.key.contains('Minor') ? money('${e.value}', hidden: context.app.hideAmounts) : e.value}')),
      if (rejected) InfoBanner('Refusé : ${(d['validation'] as List).join(', ')}', color: p.error, icon: Icons.block_rounded),
      if (d['state'] == 'CONFLICT') const InfoBanner('Conflit : la ressource a changé sur le serveur. Appliquer sur la dernière version, ou abandonner.', icon: Icons.call_split_rounded),
      gap(10),
      Row(children: [
        Expanded(child: OutlinedButton(onPressed: () async { await run(context, () => context.appRead.api.post('/sync/drafts/${d['id']}/discard')); if (context.mounted) context.appRead.bump(); }, child: const Text('Abandonner'))),
        const SizedBox(width: 10),
        if (!rejected) Expanded(child: FilledButton(onPressed: () async {
          final r = await run(context, () => context.appRead.api.post('/sync/drafts/${d['id']}/confirm', {'payloadHash': d['canonicalPayloadHash'], if (d['state'] == 'CONFLICT') 'resolution': 'APPLY_ON_LATEST'}), success: 'Modification appliquée');
          if (r != null && context.mounted) context.appRead.bump(); else if (context.mounted) context.appRead.bump();
        }, child: Text(d['state'] == 'CONFLICT' ? 'Appliquer sur la dernière version' : 'Confirmer cette modification'))),
      ]),
    ]));
  }
}

/// Préférences et personnalisation (UX16, §2.6).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final p = context.pal;
    return PageScaffold(title: 'Préférences', back: true, showGlobalActions: false, children: [
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Apparence', style: sora(16, color: p.ink)), gap(10),
        SegmentedButton(segments: const [ButtonSegment(value: ThemeMode.system, label: Text('Système'), icon: Icon(Icons.brightness_auto_rounded)), ButtonSegment(value: ThemeMode.light, label: Text('Clair'), icon: Icon(Icons.light_mode_rounded)), ButtonSegment(value: ThemeMode.dark, label: Text('Sombre'), icon: Icon(Icons.dark_mode_rounded))], selected: {app.themeMode}, onSelectionChanged: (s) => app.setTheme(s.first)),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: app.reduceMotion, onChanged: app.setReduceMotion, title: const Text('Réduire les animations'), subtitle: const Text('Suit aussi le réglage d’accessibilité du système')),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: app.hideAmounts, onChanged: (_) => app.toggleAmounts(), title: const Text('Masquer les montants'), subtitle: const Text('Tableaux, graphiques, recherches et exports. Ce n’est pas une mesure d’authentification.')),
      ])),
      gap(),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Compte', style: sora(16, color: p.ink)), gap(8),
        KeyValue('E-mail', Text(app.me?['email'] ?? '—')), KeyValue('Fuseau', Text(app.me?['timezone'] ?? 'Africa/Porto-Novo')), KeyValue('Notifications push', Flexible(child: Text(app.push.status, textAlign: TextAlign.right, maxLines: 2, overflow: TextOverflow.ellipsis, style: inter(13, w: FontWeight.w600, color: app.push.status == 'Activées' ? p.success : p.inkMuted)))), KeyValue('Serveur', Flexible(child: Text(app.api.baseUrl, textAlign: TextAlign.right, style: inter(12.5, color: p.inkMuted)))),
        KeyValue('Clé de cet appareil', FutureBuilder<String>(future: app.key.publicKeyB64().then((k) async => base64Encode((await Sha256().hash(base64Decode(k))).bytes).substring(0, 16)), builder: (_, s) => Text(s.data ?? '…', style: inter(12.5, tab: true, color: p.inkMuted)))),
        gap(8), OutlinedButton.icon(onPressed: () => context.push('/security'), icon: const Icon(Icons.shield_outlined), label: const Text('Centre de sécurité')),
        gap(8), OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: p.error), onPressed: () async { if (await confirmDanger(context, title: 'Se déconnecter ?', message: 'La session est révoquée côté serveur. La clé de l’appareil est conservée pour une reconnexion.')) app.signOut(); }, icon: const Icon(Icons.logout_rounded), label: const Text('Se déconnecter')),
      ])),
      gap(),
      Text('Raccourcis Mac : ⌘K recherche · ⌘1–5 espaces · ⌘N dépense · ⇧⌘H masquer les montants', style: inter(12.5, color: p.inkMuted)),
    ]);
  }
}

class NotFoundScreen extends StatelessWidget {
  final String path;
  const NotFoundScreen({super.key, required this.path});
  @override
  Widget build(BuildContext context) => Scaffold(body: EmptyState(icon: Icons.explore_off_rounded, title: 'Page introuvable', message: path, action: 'Accueil', onAction: () => context.go('/home')));
}
