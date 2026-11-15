import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'core/app_state.dart';
import 'core/push.dart';
import 'design/motion.dart';
import 'design/theme.dart';
import 'design/tokens.dart';
import 'features/router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('fr');
  try { await PushReceiver.init(); } catch (_) {}
  final app = AppState();
  runApp(RavzoApp(state: app));
  await app.boot();
}

class RavzoApp extends StatefulWidget {
  final AppState state;
  const RavzoApp({super.key, required this.state});
  @override
  State<RavzoApp> createState() => _RavzoAppState();
}
class _RavzoAppState extends State<RavzoApp> {
  late final router = buildRouter(widget.state);
  @override
  Widget build(BuildContext context) => AppScope(state: widget.state, child: ListenableBuilder(listenable: widget.state, builder: (context, _) {
    final s = widget.state;
    return MaterialApp.router(
      title: 'RAVZO', debugShowCheckedModeBanner: false, routerConfig: router, themeMode: s.themeMode,
      theme: buildTheme(Palette.light), darkTheme: buildTheme(Palette.dark),
      locale: const Locale('fr'), supportedLocales: const [Locale('fr')],
      localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      builder: (c, child) => PaletteScope(palette: Theme.of(c).brightness == Brightness.dark ? Palette.dark : Palette.light, child: ReduceMotionScope(reduce: s.reduceMotion, child: child!)),
    );
  }));
}
