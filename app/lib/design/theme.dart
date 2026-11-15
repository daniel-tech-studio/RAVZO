import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'tokens.dart';

const tabular = [FontFeature.tabularFigures()];

/// Sora : titres/identité/grands indicateurs. Inter : texte, tableaux, montants fonctionnels (llm.md §2.3).
TextStyle sora(double size, {FontWeight w = FontWeight.w600, Color? color, double? height, double? spacing}) =>
    GoogleFonts.sora(fontSize: size, fontWeight: w, color: color, height: height, letterSpacing: spacing ?? (size > 24 ? -0.6 : -0.2), fontFeatures: tabular);
TextStyle inter(double size, {FontWeight w = FontWeight.w400, Color? color, double? height, bool tab = false}) =>
    GoogleFonts.inter(fontSize: size, fontWeight: w, color: color, height: height, fontFeatures: tab ? tabular : null);

ThemeData buildTheme(Palette p) {
  final base = ThemeData(useMaterial3: true, brightness: p.brightness);
  final scheme = ColorScheme(
    brightness: p.brightness, primary: p.primary, onPrimary: p.onPrimary, secondary: p.accent, onSecondary: const Color(0xFF0E2A24), secondaryContainer: p.accentSoft, onSecondaryContainer: p.brightness == Brightness.light ? p.primary : p.ink,
    tertiary: p.copper, onTertiary: p.ink, error: p.error, onError: Colors.white, surface: p.surface, onSurface: p.ink,
    surfaceContainerHighest: p.surfaceAlt, outline: p.border, outlineVariant: p.border,
  );
  final text = GoogleFonts.interTextTheme(base.textTheme).apply(bodyColor: p.ink, displayColor: p.ink);
  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: p.background,
    textTheme: text.copyWith(
      headlineLarge: sora(30, color: p.ink), headlineMedium: sora(24, color: p.ink), headlineSmall: sora(20, color: p.ink),
      titleLarge: sora(18, color: p.ink), titleMedium: inter(16, w: FontWeight.w600, color: p.ink), bodyLarge: inter(16, color: p.ink), bodyMedium: inter(14.5, color: p.ink),
      labelLarge: inter(14.5, w: FontWeight.w600, color: p.ink),
    ),
    dividerTheme: DividerThemeData(color: p.border, thickness: 1, space: 1),
    inputDecorationTheme: InputDecorationTheme(
      filled: true, fillColor: p.surfaceAlt.withValues(alpha: p.brightness == Brightness.light ? .55 : .7),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.field), borderSide: BorderSide(color: p.border)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.field), borderSide: BorderSide(color: p.border)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.field), borderSide: BorderSide(color: p.primary, width: 1.6)),
      errorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.field), borderSide: BorderSide(color: p.error)),
      labelStyle: inter(14, color: p.inkMuted), hintStyle: inter(14, color: p.inkMuted),
    ),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size(48, 50), backgroundColor: p.primary, foregroundColor: p.onPrimary, textStyle: inter(15, w: FontWeight.w600), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.button)))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 50), foregroundColor: p.ink, side: BorderSide(color: p.border), textStyle: inter(15, w: FontWeight.w600), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.button)))),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: p.primary, textStyle: inter(14.5, w: FontWeight.w600))),
    chipTheme: base.chipTheme.copyWith(backgroundColor: p.surface, selectedColor: p.accentSoft, side: BorderSide(color: p.border), labelStyle: inter(13.5, w: FontWeight.w500, color: p.ink), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.pill))),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: p.surface, indicatorColor: p.accentSoft, elevation: 0, height: 68, labelTextStyle: WidgetStatePropertyAll(inter(12, w: FontWeight.w600, color: p.inkSoft)), iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? p.primary : p.inkMuted))),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: p.surface, showDragHandle: true, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.hero)))),
    dialogTheme: DialogThemeData(backgroundColor: p.surface, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.hero))),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: p.ink, contentTextStyle: inter(14, color: p.background), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
    segmentedButtonTheme: SegmentedButtonThemeData(style: ButtonStyle(
      backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.accentSoft : Colors.transparent),
      foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? (p.brightness == Brightness.light ? p.primary : p.ink) : p.inkSoft),
      side: WidgetStatePropertyAll(BorderSide(color: p.border)), textStyle: WidgetStatePropertyAll(inter(13.5, w: FontWeight.w600)))),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.onPrimary : p.inkMuted),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? p.primary : p.surfaceAlt),
      trackOutlineColor: WidgetStatePropertyAll(p.border)),
    tabBarTheme: TabBarThemeData(labelColor: p.primary, unselectedLabelColor: p.inkMuted, indicatorColor: p.primary, labelStyle: inter(14, w: FontWeight.w600), dividerColor: Colors.transparent),
    pageTransitionsTheme: const PageTransitionsTheme(builders: { TargetPlatform.macOS: FadeForwardsPageTransitionsBuilder(), TargetPlatform.iOS: CupertinoPageTransitionsBuilder(), TargetPlatform.android: FadeForwardsPageTransitionsBuilder() }),
  );
}
