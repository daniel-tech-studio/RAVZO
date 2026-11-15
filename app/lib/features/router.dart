import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../core/app_state.dart';
import 'activity/activity.dart';
import 'auth/auth_screens.dart';
import 'home/home.dart';
import 'money/money.dart';
import 'money/payments.dart';
import 'savings/savings.dart';
import 'security/security.dart';
import 'shell.dart';
import 'tools/tools.dart';
import 'wealth/wealth.dart';

GoRouter buildRouter(AppState app) {
  Page<void> fade(Widget w, GoRouterState s) => CustomTransitionPage(key: s.pageKey, child: w, transitionDuration: const Duration(milliseconds: 380),
    transitionsBuilder: (c, a, _, child) => FadeTransition(opacity: CurvedAnimation(parent: a, curve: Curves.easeOutCubic), child: SlideTransition(position: Tween(begin: const Offset(0, .02), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: Curves.easeOutCubic)), child: child)));
  GoRoute r(String path, Widget Function(GoRouterState) b) => GoRoute(path: path, pageBuilder: (c, s) => fade(b(s), s));
  return GoRouter(
    initialLocation: '/home', refreshListenable: app,
    redirect: (c, s) {
      final loc = s.matchedLocation;
      final authPaths = loc.startsWith('/welcome') || loc.startsWith('/login') || loc.startsWith('/recovery');
      if (app.phase == SessionPhase.booting) return loc == '/splash' ? null : '/splash';
      if (app.phase == SessionPhase.signedOut) return authPaths ? null : '/welcome';
      if (app.phase == SessionPhase.pendingDevice) return loc == '/enroll' ? null : '/enroll';
      if (authPaths || loc == '/enroll' || loc == '/splash') return '/home';
      return null;
    },
    routes: [
      r('/splash', (_) => const SplashScreen()),
      r('/welcome', (_) => const WelcomeScreen()),
      r('/login', (_) => const LoginScreen()),
      r('/recovery', (_) => const RecoveryScreen()),
      r('/enroll', (_) => const EnrollScreen()),
      StatefulShellRoute.indexedStack(
        builder: (c, s, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [r('/home', (_) => const HomeScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/money', pageBuilder: (c, s) => fade(MoneyScreen(initialTab: s.uri.queryParameters['tab']), s), routes: [
            r('accounts/:id', (s) => AccountDetailScreen(id: s.pathParameters['id']!)),
            r('payments/:id', (s) => PaymentDetailScreen(id: s.pathParameters['id']!)),
            r('liabilities/:id', (s) => LiabilityDetailScreen(id: s.pathParameters['id']!)),
            r('incomes/:id', (s) => IncomeDetailScreen(id: s.pathParameters['id']!)),
            r('budgets/off-cycle', (_) => const OffCycleScreen()),
            r('budgets/cycles/:id', (s) => CycleScreen(id: s.pathParameters['id']!)),
          ])]),
          StatefulShellBranch(routes: [GoRoute(path: '/savings', pageBuilder: (c, s) => fade(const SavingsScreen(), s), routes: [r(':id', (s) => GoalDetailScreen(id: s.pathParameters['id']!))])]),
          StatefulShellBranch(routes: [GoRoute(path: '/wealth', pageBuilder: (c, s) => fade(WealthScreen(initialTab: s.uri.queryParameters['tab']), s), routes: [
            r('assets/:id', (s) => AssetDetailScreen(id: s.pathParameters['id']!)),
            r('market/:id', (s) => SecurityDetailScreen(id: s.pathParameters['id']!)),
          ])]),
          StatefulShellBranch(routes: [GoRoute(path: '/activity', pageBuilder: (c, s) => fade(ActivityScreen(initialTab: s.uri.queryParameters['tab']), s), routes: [
            r('reconciliation/:id', (s) => ReconciliationCaseScreen(id: s.pathParameters['id']!)),
            r('imports/:id', (s) => ImportReviewScreen(id: s.pathParameters['id']!)),
            r('expenses/:id', (s) => LedgerRedirect(kind: 'Expense', id: s.pathParameters['id']!)),
          ])]),
        ],
      ),
      r('/security', (s) => SecurityScreen(initialTab: s.uri.queryParameters['tab'])),
      r('/security/devices', (_) => const SecurityScreen(initialTab: 'devices')),
      r('/security/sessions', (_) => const SecurityScreen(initialTab: 'devices')),
      r('/security/limits', (_) => const SecurityScreen(initialTab: 'limits')),
      r('/security/exceptions/:id', (_) => const SecurityScreen(initialTab: 'limits')),
      r('/notifications', (_) => const NotificationsScreen()),
      r('/operations', (_) => const OperationsScreen()),
      r('/search', (s) => SearchScreen(initial: s.uri.queryParameters['q'])),
      r('/sync', (_) => const SyncCenterScreen()),
      r('/sync/drafts/:id', (_) => const SyncCenterScreen()),
      r('/settings', (_) => const SettingsScreen()),
    ],
    errorBuilder: (c, s) => NotFoundScreen(path: s.uri.toString()),
  );
}
