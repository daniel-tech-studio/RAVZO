import 'package:flutter/material.dart';

/// Palette validée « Calm Wealth — Expressive Edition » (llm.md §2.2).
class Palette {
  final Color background, surface, surfaceAlt, surfaceRaised, ink, inkSoft, inkMuted, border, primary, onPrimary, accent, accentSoft, copper, info, warning, error, neutral, success;
  final Brightness brightness;
  const Palette({required this.brightness, required this.background, required this.surface, required this.surfaceAlt, required this.surfaceRaised, required this.ink, required this.inkSoft, required this.inkMuted, required this.border, required this.primary, required this.onPrimary, required this.accent, required this.accentSoft, required this.copper, required this.info, required this.warning, required this.error, required this.neutral, required this.success});

  static const light = Palette(
    brightness: Brightness.light,
    background: Color(0xFFF6F7F2), surface: Color(0xFFFFFFFF), surfaceAlt: Color(0xFFE9F0ED), surfaceRaised: Color(0xFFFFFFFF),
    ink: Color(0xFF1D2B2A), inkSoft: Color(0xFF3E4F4C), inkMuted: Color(0xFF52625F), border: Color(0xFFD9E3DF),
    primary: Color(0xFF176356), onPrimary: Color(0xFFFFFFFF), accent: Color(0xFFA1E6CC), accentSoft: Color(0xFFD7F3E8),
    copper: Color(0xFFB9824A), info: Color(0xFF365C91), warning: Color(0xFF94631A), error: Color(0xFFAD443F), neutral: Color(0xFF52625F), success: Color(0xFF176356),
  );
  static const dark = Palette(
    brightness: Brightness.dark,
    background: Color(0xFF111C20), surface: Color(0xFF1A2B30), surfaceAlt: Color(0xFF213940), surfaceRaised: Color(0xFF22363C),
    ink: Color(0xFFF2F6F3), inkSoft: Color(0xFFD3DEDB), inkMuted: Color(0xFFB0C1BE), border: Color(0xFF2E4950),
    primary: Color(0xFF7FD9B9), onPrimary: Color(0xFF0E2A24), accent: Color(0xFFA1E6CC), accentSoft: Color(0xFF1F4A40),
    copper: Color(0xFFE2B57F), info: Color(0xFF8FB3E8), warning: Color(0xFFE3B66A), error: Color(0xFFF08A84), neutral: Color(0xFFB0C1BE), success: Color(0xFF7FD9B9),
  );

  /// Dégradé identitaire (vert jade → menthe), repris du monogramme.
  LinearGradient get heroGradient => brightness == Brightness.light
      ? const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF0E4F44), Color(0xFF176356), Color(0xFF2E8C77)])
      : const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF0B2E29), Color(0xFF134A40), Color(0xFF1F6B5B)]);
  LinearGradient get copperGradient => const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFF0B472), Color(0xFFC77B33)]);
}

/// Échelle d'espacement 4–48 (llm.md §2.4).
class Space { static const xs = 4.0, s = 8.0, m = 12.0, l = 16.0, xl = 20.0, xxl = 24.0, x3 = 32.0, x4 = 40.0, x5 = 48.0; }
class Radii { static const card = 18.0, hero = 24.0, button = 13.0, field = 12.0, pill = 99.0; }

class PaletteScope extends InheritedWidget {
  final Palette palette;
  const PaletteScope({super.key, required this.palette, required super.child});
  static Palette of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<PaletteScope>()?.palette ?? (Theme.of(c).brightness == Brightness.dark ? Palette.dark : Palette.light);
  @override
  bool updateShouldNotify(PaletteScope old) => old.palette != palette;
}
extension PaletteX on BuildContext { Palette get pal => PaletteScope.of(this); }
