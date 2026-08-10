// Kitsune's single frontend entry point, loaded via <script type="module"
// src="app.js"> on every page. Every page's own feature logic is now React
// (see README's "React migration" section, which finished with Settings >
// Metadata) — the only thing left here is the shared sidebar/page-tabs nav,
// still plain JS and shared by every page regardless of migration status.
import './js/nav.js';
