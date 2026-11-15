import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:ravzo/core/api.dart';
import 'package:ravzo/core/app_state.dart';
import 'package:ravzo/design/components.dart';
import 'package:ravzo/design/motion.dart';
import 'package:ravzo/design/theme.dart';
import 'package:ravzo/design/tokens.dart';

Widget host(AppState s, Widget child) => AppScope(state: s, child: MaterialApp(theme: buildTheme(Palette.light), home: PaletteScope(palette: Palette.light, child: ReduceMotionScope(reduce: true, child: Scaffold(body: child)))));

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  testWidgets('Money respecte le masquage global (UX23)', (t) async {
    final s = AppState(baseUrl: 'http://localhost:1');
    await t.pumpWidget(host(s, const Money('150000')));
    expect(find.text('150 000 FCFA'), findsOneWidget);
    s.hideAmounts = true;
    s.bump();
    await t.pumpAndSettle();
    expect(find.text('•••••• FCFA'), findsOneWidget);
    expect(find.textContaining('150'), findsNothing);
  });

  testWidgets('Étiquettes de provenance et états en français', (t) async {
    final s = AppState(baseUrl: 'http://localhost:1');
    await t.pumpWidget(host(s, const Column(children: [DataLabel('CONFIRMED'), DataLabel('ESTIMATED'), DataLabel('SIMULATED'), StatePill('UNKNOWN')])));
    expect(find.text('Confirmé'), findsOneWidget);
    expect(find.text('Estimé'), findsOneWidget);
    expect(find.text('Simulé'), findsOneWidget);
    expect(find.text('Incertain'), findsOneWidget); // UNKNOWN n'est jamais affiché comme « échoué »
  });

  testWidgets('Loader : erreur hors ligne avec action de réessai', (t) async {
    final s = AppState(baseUrl: 'http://localhost:1');
    var calls = 0;
    await t.pumpWidget(host(s, Loader<Map>(load: (_) async { calls++; throw ApiError(0, 'OFFLINE', 'Hors ligne : serveur injoignable'); }, builder: (c, d, _) => const Text('ok'))));
    await t.pumpAndSettle();
    expect(find.text('Hors ligne'), findsOneWidget);
    await t.tap(find.text('Réessayer'));
    await t.pumpAndSettle();
    expect(calls, 2);
  });

  testWidgets('Loader page : un Scaffold est rendu sans erreur de mise en page', (t) async {
    final s = AppState(baseUrl: 'http://localhost:1');
    await t.pumpWidget(AppScope(state: s, child: MaterialApp(home: Loader<int>(page: true, load: (_) async => 1, builder: (c, d, _) => const Scaffold(body: Text('détail'))))));
    await t.pumpAndSettle();
    expect(find.text('détail'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
