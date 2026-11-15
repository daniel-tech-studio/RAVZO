import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import '../core/app_state.dart';
import '../core/format.dart';
import '../design/components.dart';
import '../design/motion.dart';
import '../design/theme.dart';
import '../design/tokens.dart';
import 'money/money.dart';

const _nav = [
  (icon: Icons.space_dashboard_outlined, active: Icons.space_dashboard_rounded, label: 'Accueil'),
  (icon: Icons.account_balance_wallet_outlined, active: Icons.account_balance_wallet_rounded, label: 'Argent'),
  (icon: Icons.savings_outlined, active: Icons.savings_rounded, label: 'Épargne'),
  (icon: Icons.diamond_outlined, active: Icons.diamond_rounded, label: 'Patrimoine'),
  (icon: Icons.receipt_long_outlined, active: Icons.receipt_long_rounded, label: 'Activité'),
];

/// Liens serveur (notifications, opérations) → routes client ; les sous-chemins inconnus ouvrent l'onglet correspondant.
void goLink(BuildContext context, String? link) {
  if (link == null) return;
  const tabMap = {'/money/obligations': '/money?tab=obligations', '/money/budgets': '/money?tab=budgets', '/money/beneficiaries': '/money?tab=payments', '/wealth/dividends': '/wealth?tab=dividends', '/security/sessions': '/security?tab=devices'};
  final l = tabMap[link.split('?').first] ?? link;
  final top = ['/home', '/money', '/savings', '/wealth', '/activity'].any((p) => l == p || l.startsWith('$p/') || l.startsWith('$p?'));
  top ? context.go(l) : context.push(l);
}

class AppShell extends StatelessWidget {
  final StatefulNavigationShell shell;
  const AppShell({super.key, required this.shell});
  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final app = context.app;
    final p = context.pal;
    if (app.pendingLink != null) { final l = app.pendingLink; app.pendingLink = null; WidgetsBinding.instance.addPostFrameCallback((_) => goLink(context, l)); }
    final body = Column(children: [
      if (!app.online) const _OfflineBar(),
      if (app.me?['restrictions']?['financialReadOnlyUntil'] != null) InfoBanner('Suspension de sécurité active jusqu’au ${fmtDateTime(app.me!['restrictions']['financialReadOnlyUntil'])} : consultation seule pour les opérations financières.', icon: Icons.lock_clock_rounded, color: p.warning),
      Expanded(child: shell),
    ]);
    return Shortcuts(
      shortcuts: {
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): const _Go('/search'),
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): const _Go('/search'),
        for (var i = 0; i < 5; i++) SingleActivator(LogicalKeyboardKey(LogicalKeyboardKey.digit1.keyId + i), meta: true): _Tab(i),
        const SingleActivator(LogicalKeyboardKey.keyH, meta: true, shift: true): const _Mask(),
        const SingleActivator(LogicalKeyboardKey.keyN, meta: true): const _NewExpense(),
      },
      child: Actions(actions: {
        _Go: CallbackAction<_Go>(onInvoke: (i) => context.push(i.path)),
        _Tab: CallbackAction<_Tab>(onInvoke: (i) => shell.goBranch(i.index)),
        _Mask: CallbackAction<_Mask>(onInvoke: (_) => app.toggleAmounts()),
        _NewExpense: CallbackAction<_NewExpense>(onInvoke: (_) => openExpenseForm(context)),
      }, child: Focus(autofocus: true, child: wide
        ? Scaffold(body: Row(children: [_Sidebar(shell: shell), VerticalDivider(width: 1, color: p.border), Expanded(child: body)]))
        : Scaffold(body: SafeArea(bottom: false, child: body), bottomNavigationBar: NavigationBar(
            selectedIndex: shell.currentIndex, onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
            destinations: [for (final n in _nav) NavigationDestination(icon: Icon(n.icon), selectedIcon: Icon(n.active), label: n.label)])))),
    );
  }
}
class _Go extends Intent { final String path; const _Go(this.path); }
class _Tab extends Intent { final int index; const _Tab(this.index); }
class _Mask extends Intent { const _Mask(); }
class _NewExpense extends Intent { const _NewExpense(); }

class _OfflineBar extends StatelessWidget {
  const _OfflineBar();
  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return Container(width: double.infinity, color: context.pal.warning.withValues(alpha: .14), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(children: [Icon(Icons.cloud_off_rounded, size: 18, color: context.pal.warning), const SizedBox(width: 8), Expanded(child: Text('Hors ligne — données du ${app.lastSync == null ? '—' : fmtDateTime(app.lastSync!.toUtc().toIso8601String())}. Paiements et validations sensibles indisponibles ; vos saisies deviennent des brouillons.', style: inter(13, color: context.pal.ink)))]));
  }
}

class _Sidebar extends StatelessWidget {
  final StatefulNavigationShell shell;
  const _Sidebar({required this.shell});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final app = context.app;
    return Container(width: 248, color: p.surface, child: SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 18, 16, 16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.asset('assets/brand/monogram.png', width: 36, height: 36)), const SizedBox(width: 10), Text('RAVZO', style: sora(20, w: FontWeight.w700, color: p.primary, spacing: 1.5))]),
      const SizedBox(height: 22),
      Pressable(onTap: () => context.push('/search'), child: Container(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10), decoration: BoxDecoration(color: p.surfaceAlt.withValues(alpha: .6), borderRadius: BorderRadius.circular(12)),
        child: Row(children: [Icon(Icons.search_rounded, size: 19, color: p.inkMuted), const SizedBox(width: 8), Expanded(child: Text('Rechercher', style: inter(14, color: p.inkMuted))), Text('⌘K', style: inter(12, w: FontWeight.w600, color: p.inkMuted))]))),
      const SizedBox(height: 16),
      for (var i = 0; i < _nav.length; i++) _SideItem(icon: shell.currentIndex == i ? _nav[i].active : _nav[i].icon, label: _nav[i].label, selected: shell.currentIndex == i, hint: '⌘${i + 1}', onTap: () => shell.goBranch(i, initialLocation: i == shell.currentIndex)),
      const Spacer(),
      _SideItem(icon: Icons.task_alt_rounded, label: 'Opérations', badge: app.needsIntervention, onTap: () => context.push('/operations')),
      _SideItem(icon: Icons.notifications_none_rounded, label: 'Notifications', badge: app.unread, critical: app.unreadCritical > 0, onTap: () => context.push('/notifications')),
      _SideItem(icon: Icons.sync_rounded, label: 'Synchronisation', badge: app.localDrafts.length, onTap: () => context.push('/sync')),
      _SideItem(icon: Icons.shield_outlined, label: 'Sécurité', onTap: () => context.push('/security')),
      _SideItem(icon: Icons.tune_rounded, label: 'Préférences', onTap: () => context.push('/settings')),
      const SizedBox(height: 10),
      _SyncStatus(app: app),
    ]))));
  }
}
class _SyncStatus extends StatelessWidget {
  final AppState app;
  const _SyncStatus({required this.app});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final c = !app.online ? p.warning : app.streamConnected ? p.success : p.inkMuted;
    return Row(children: [Container(width: 8, height: 8, decoration: BoxDecoration(color: c, shape: BoxShape.circle)), const SizedBox(width: 8), Expanded(child: Text(!app.online ? 'Hors ligne' : app.streamConnected ? 'Synchronisé · temps réel' : 'Reconnexion…', style: inter(12, color: p.inkMuted))),
      IconButton(tooltip: app.hideAmounts ? 'Afficher les montants (⇧⌘H)' : 'Masquer les montants (⇧⌘H)', onPressed: app.toggleAmounts, icon: Icon(app.hideAmounts ? Icons.visibility_off_rounded : Icons.visibility_rounded, size: 20, color: p.inkMuted))]);
  }
}
class _SideItem extends StatelessWidget {
  final IconData icon; final String label; final bool selected; final VoidCallback onTap; final String? hint; final int badge; final bool critical;
  const _SideItem({required this.icon, required this.label, required this.onTap, this.selected = false, this.hint, this.badge = 0, this.critical = false});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    return Padding(padding: const EdgeInsets.only(bottom: 4), child: Pressable(onTap: onTap, child: AnimatedContainer(duration: Motion.d(context, Motion.base), curve: Motion.emphasized, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: selected ? p.accentSoft : Colors.transparent, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [Icon(icon, size: 21, color: selected ? p.primary : p.inkSoft), const SizedBox(width: 12), Expanded(child: Text(label, style: inter(14.5, w: selected ? FontWeight.w700 : FontWeight.w500, color: selected ? p.primary : p.ink))),
        if (badge > 0) _Badge(badge, critical) else if (hint != null) Text(hint!, style: inter(11.5, color: p.inkMuted))]))));
  }
}
class _Badge extends StatelessWidget {
  final int n; final bool critical;
  const _Badge(this.n, this.critical);
  @override
  Widget build(BuildContext context) => Container(padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2), decoration: BoxDecoration(color: critical ? context.pal.error : context.pal.copper, borderRadius: BorderRadius.circular(99)), child: Text('$n', style: inter(11.5, w: FontWeight.w700, color: Colors.white)));
}

/// En-tête de page : titre expressif + accès discrets (recherche, opérations avec indicateur, notifications, masquage, profil).
class PageScaffold extends StatelessWidget {
  final String title;
  final String? subtitle;
  final List<Widget> children;
  final Widget? fab;
  final List<Widget> actions;
  final Future<void> Function()? onRefresh;
  final bool showGlobalActions, back;
  const PageScaffold({super.key, required this.title, this.subtitle, required this.children, this.fab, this.actions = const [], this.onRefresh, this.showGlobalActions = true, this.back = false});
  @override
  Widget build(BuildContext context) {
    final p = context.pal;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final app = context.app;
    final header = Padding(padding: EdgeInsets.fromLTRB(wide ? 36 : 20, wide ? 28 : 12, wide ? 36 : 12, 8), child: Row(children: [
      if (back || (Navigator.of(context).canPop() && !wide)) IconButton(onPressed: () => context.canPop() ? context.pop() : context.go('/home'), icon: const Icon(Icons.arrow_back_rounded), tooltip: 'Retour'),
      if (back && wide) const SizedBox(width: 4),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: sora(wide ? 30 : 26, w: FontWeight.w700, color: p.ink)),
        if (subtitle != null) Text(subtitle!, style: inter(14, color: p.inkMuted)),
      ])),
      ...actions,
      if (showGlobalActions && !wide) ...[
        IconButton(tooltip: 'Recherche', onPressed: () => context.push('/search'), icon: const Icon(Icons.search_rounded)),
        _IconWithDot(icon: Icons.task_alt_rounded, show: app.needsIntervention > 0, tooltip: 'Centre des opérations', onTap: () => context.push('/operations')),
        _IconWithDot(icon: Icons.notifications_none_rounded, show: app.unread > 0, critical: app.unreadCritical > 0, tooltip: 'Notifications', onTap: () => context.push('/notifications')),
        PopupMenuButton<String>(tooltip: 'Plus', icon: const Icon(Icons.more_horiz_rounded), onSelected: (v) => v == 'mask' ? app.toggleAmounts() : context.push(v), itemBuilder: (_) => [
          PopupMenuItem(value: 'mask', child: Text(app.hideAmounts ? 'Afficher les montants' : 'Masquer les montants')),
          const PopupMenuItem(value: '/security', child: Text('Centre de sécurité')), const PopupMenuItem(value: '/sync', child: Text('Synchronisation')), const PopupMenuItem(value: '/settings', child: Text('Préférences')),
        ]),
      ],
    ]));
    final list = ListView(padding: EdgeInsets.fromLTRB(wide ? 36 : 16, 8, wide ? 36 : 16, 110), children: [for (var i = 0; i < children.length; i++) Enter(index: i, child: children[i])]);
    final content = Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1240), child: Column(children: [header, Expanded(child: onRefresh == null ? list : RefreshIndicator(onRefresh: onRefresh!, child: list))])));
    return Scaffold(backgroundColor: p.background, body: SafeArea(child: content), floatingActionButton: fab);
  }
}
class _IconWithDot extends StatelessWidget {
  final IconData icon; final bool show, critical; final String tooltip; final VoidCallback onTap;
  const _IconWithDot({required this.icon, required this.show, required this.tooltip, required this.onTap, this.critical = false});
  @override
  Widget build(BuildContext context) => IconButton(tooltip: tooltip, onPressed: onTap, icon: Stack(clipBehavior: Clip.none, children: [Icon(icon), if (show) Positioned(right: -1, top: -1, child: Container(width: 9, height: 9, decoration: BoxDecoration(color: critical ? context.pal.error : context.pal.copper, shape: BoxShape.circle, border: Border.all(color: context.pal.background, width: 1.5))))]));
}
