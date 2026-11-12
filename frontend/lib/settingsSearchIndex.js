// Everything the Settings search box can find, across every Settings page.
//
// A hand-written index rather than something scraped from the pages at
// runtime: every Settings page is its own .html file whose content only
// exists once that page's React bundle has rendered it (and, for most of
// them, once its GET /api/settings/... round trip has come back), so there's
// nothing to search on any page you aren't currently looking at. Several of
// the most-searched-for things also never appear on a page at all until you
// open a modal (a download client's Category, a Prowlarr indexer's API Key).
//
// Kept honest by scripts/check-settings-search-index.js, which runs as part
// of `npm run build` and warns about any literal FormRow / SettingsCard /
// FieldRow / fieldRow label on a Settings page that doesn't appear in here —
// so a new setting nobody added to this file gets flagged instead of
// silently being unsearchable.
//
// Shape: one entry per page, each with sections (a `.settings-card` title,
// or a `context` for things that only live in a modal or a list), each with
// fields as [name, desc?, keywords?]. `name` and `title` must match the text
// the page actually renders (a FormRow's name, a card's <h2>) — that's how
// the target page finds the row to scroll to and highlight. Sections with a
// `context` instead of a card title just open the page, since there's
// nothing on screen to point at until you open the modal yourself — unless
// `targetOnPage` says those fields are always visible anyway (Quality's
// toolbar).
//
// `keywords` are extra words people might search for that don't appear in
// the name or description: synonyms, the Sonarr/Radarr name for the same
// thing, the protocol or tool it's about.

const PAGES = [
  {
    file: 'settings-media-management.html',
    label: 'Media Management',
    desc: 'Naming, folders, and file handling behavior.',
    keywords: 'rename naming files folders',
    sections: [
      {
        title: 'Episode Naming',
        desc: 'Controls how downloaded episodes are renamed and organized on disk.',
        fields: [
          ['Rename Episodes', 'Kitsune renames episodes on import to match the format below.', 'naming'],
          ['Standard Episode Format', 'For series numbered by season and episode.', 'naming template token filename'],
          ['Anime Episode Format', 'For series numbered by absolute episode count.', 'naming template token filename absolute'],
          ['Series Folder Format', 'Root-level folder created for each series.', 'naming template directory'],
          ['Season Folder Format', 'Subfolder created for each season within a series.', 'naming template directory'],
        ],
      },
      {
        title: 'Root Folders',
        desc: 'Default locations Kitsune can import series into.',
        keywords: 'library path mount directory add root folder storage',
        fields: [],
      },
      {
        title: 'New Series Defaults',
        desc: 'Applied automatically when a series is added.',
        fields: [
          ['Ignore Specials by Default', "Newly added series start with Ignore Specials turned on, so their Season 0 extras don't show up in Wanted.", 'season 0 ova extras'],
        ],
      },
      {
        title: 'File Management',
        desc: 'How Kitsune treats files during import and on disk.',
        fields: [
          ['Unmonitor Deleted Episodes', 'Episodes deleted from disk are automatically unmonitored.'],
          ['Propers and Repacks', 'Whether to prefer a Proper/Repack release over the original.', 'proper repack upgrade'],
          ['Analyze Video Files', 'Extract video/audio codec, resolution, and language info on import.', 'mediainfo ffprobe probe codec'],
          ['Replace Illegal Characters', 'Replace characters not allowed on the target filesystem instead of removing them.'],
          ['Set Permissions', 'Set Unix file/folder permissions on import.', 'chmod chown'],
          ['Folder Chmod', 'Octal permissions applied to created folders.', 'permissions 755'],
          ['File Chmod', 'Octal permissions applied to imported files.', 'permissions 644'],
          ['chown User', 'Owner to set on imported files/folders. Accepts a username or numeric uid.', 'owner uid puid permissions'],
          ['chown Group', 'Group to set on imported files/folders. Accepts a group name or numeric gid.', 'gid pgid permissions'],
        ],
      },
      {
        title: 'Importing',
        desc: 'Behavior when Kitsune imports completed downloads.',
        fields: [
          ['Skip Free Space Check', 'Skip the free space check before importing.', 'disk'],
          ['Minimum Free Space', 'Minimum free disk space (MB) required to import.', 'disk'],
          ['Use Hardlinks Instead of Copy', 'Try to hardlink files instead of copying when possible.', 'hardlink seeding'],
          ['Import Extra Files', 'Extra file extensions to import alongside episodes.', 'subtitles srt ass nfo'],
        ],
      },
    ],
  },
  {
    file: 'settings-profiles.html',
    label: 'Profiles',
    desc: 'Quality profiles define which releases are acceptable, and when Kitsune should upgrade.',
    keywords: 'quality profile',
    sections: [
      {
        context: 'Add / edit profile',
        fields: [
          ['Add profile', 'Create a new quality profile, blank or copied from an existing one.', 'new create'],
          ['Default profile', "The quality profile new series get when they're added.", 'star default new series'],
          ['Name', 'Profile name.'],
          ['Cutoff', 'Kitsune stops upgrading a series once a release at or above this quality is downloaded.', 'upgrade until'],
          ['Upgrades allowed', null, 'upgrade'],
          ['Qualities', 'Releases in these tiers are ranked to the top of search results and eligible for "Grab best match."', 'allowed qualities tiers'],
        ],
      },
    ],
  },
  {
    file: 'settings-quality.html',
    label: 'Quality',
    desc: 'Define file size limits per quality tier.',
    keywords: 'quality definitions size limits tiers',
    sections: [
      {
        context: 'Toolbar',
        targetOnPage: true,
        fields: [
          ['Preset', 'Storage Saver, Balanced, High Bitrate or Remux Focus size limits.', 'storage saver balanced high bitrate remux'],
          ['Reference Runtime', 'Episode length the size estimates are based on.', 'runtime minutes length'],
          ['Display', 'Show limits as estimated file size or MB per minute.', 'units rate mb per min'],
        ],
      },
      {
        context: 'Quality tiers',
        fields: [
          ['Add Quality', 'Add a quality tier and its resolution group.', 'new tier resolution group'],
          ['Minimum / Preferred / Maximum size', "Releases outside a tier's Min/Max are rejected; Preferred is what automated searches aim for.", 'min max preferred file size slider'],
        ],
      },
    ],
  },
  {
    file: 'settings-custom-formats.html',
    label: 'Custom Formats',
    desc: 'Score and tag releases based on properties like audio tracks, subtitles, or encode source.',
    keywords: 'custom format score dual audio subtitles',
    sections: [
      {
        context: 'Custom formats',
        fields: [
          ['Add custom format', 'Create a custom format to score releases.', 'new create'],
        ],
      },
      {
        context: 'Edit custom format',
        fields: [
          ['Conditions', 'How many conditions a release must match.', 'rules match'],
          ['Used in profiles', 'How many quality profiles use this format.', 'profiles'],
        ],
      },
    ],
  },
  {
    file: 'settings-indexers.html',
    label: 'Indexers',
    desc: 'Search providers Kitsune queries when looking for episodes.',
    keywords: 'indexer tracker search provider torrent',
    sections: [
      {
        context: 'Add indexer',
        fields: [
          ['Add indexer', null, 'new create'],
          ['Nyaa.si', 'Anime torrent indexer. No configuration needed.', 'nyaa'],
          ['AnimeTosho', "Searches by AniDB ID, so it finds releases whose titles don't match.", 'anidb tosho'],
          ['SeaDex', 'Community best-release picks, ranked first.', 'best release'],
          ['Prowlarr', 'Proxies every tracker configured in your Prowlarr instance.', 'jackett'],
          ['TokyoTosho'],
          ['Anirena'],
          ['Shana Project', null, 'rss'],
        ],
      },
      {
        context: 'Edit indexer',
        fields: [
          ['Name'],
          ['Base URL', "Your Prowlarr instance's address, including http(s)://.", 'prowlarr url host'],
          ['API Key', 'Settings > General > Security in Prowlarr.', 'prowlarr apikey token'],
          ['Allow self-signed certificate', 'Skips certificate verification for this indexer.', 'ssl tls insecure prowlarr'],
          ['Priority', null, 'order'],
          ['Protocol'],
        ],
      },
    ],
  },
  {
    file: 'settings-download-clients.html',
    label: 'Download Clients',
    desc: 'Where Kitsune sends grabbed episodes to download, and imports completed ones from.',
    keywords: 'download client torrent usenet',
    sections: [
      {
        context: 'Add download client',
        fields: [
          ['Add download client', null, 'new create'],
          ['qBittorrent', null, 'qbit torrent'],
          ['NZBGet', null, 'usenet nzb'],
          ['Torrents', 'See and add torrents on a connected qBittorrent client.', 'magnet browse'],
        ],
      },
      {
        context: 'Edit download client',
        keywords: 'qbittorrent qbit nzbget',
        fields: [
          ['Name'],
          ['Host', null, 'address ip'],
          ['Port'],
          ['Use SSL', null, 'https tls'],
          ['Username', null, 'login'],
          ['Password', null, 'login'],
          ['Category', "Must already exist on the client — Kitsune doesn't create categories for you.", 'label'],
          ['Client priority', 'Lower runs first when more than one client is enabled.', 'order'],
          ['Initial state', 'qBittorrent: start new torrents started, paused or forced.', 'paused qbittorrent'],
          ['Content layout', 'qBittorrent: original, subfolder or no subfolder.', 'subfolder qbittorrent'],
          ['Sequential order', 'qBittorrent: download pieces in order.', 'qbittorrent'],
          ['First and last piece priority', 'qBittorrent.', 'qbittorrent'],
          ['Remote path', 'Only needed if the client runs on a different machine than Kitsune.', 'remote path mapping docker'],
          ['Local path', "Where that same folder is reachable from Kitsune's own host.", 'remote path mapping docker mount'],
          ['NZBGet priority', null, 'usenet'],
        ],
      },
    ],
  },
  {
    file: 'settings-import-lists.html',
    label: 'Import Lists',
    desc: 'External lists Kitsune polls to automatically add new series to your library.',
    keywords: 'list auto add watchlist',
    sections: [
      {
        context: 'Add import list',
        fields: [
          ['Add import list', null, 'new create'],
          ['Simkl'],
          ['Custom RSS List', null, 'rss feed'],
          ['IMDb List', null, 'imdb'],
        ],
      },
    ],
  },
  {
    file: 'settings-connect.html',
    label: 'Connect',
    desc: 'Send notifications when Kitsune grabs, imports, or runs into trouble with a release.',
    keywords: 'notifications notify alerts webhook',
    sections: [
      {
        context: 'Add connection',
        fields: [
          ['Add connection', null, 'new create notification'],
          ['Pushover', null, 'push notification'],
          ['Slack', null, 'webhook'],
          ['Plex', null, 'library update'],
          ['Gotify', null, 'push notification'],
        ],
      },
      {
        context: 'Edit connection',
        fields: [
          ['User Key', 'Pushover user key.', 'pushover'],
          ['API Token', 'From an application registered at pushover.net/apps/build.', 'pushover apikey'],
          ['Triggers', 'Notify on grab, import or failure.', 'on grab on import on fail events'],
        ],
      },
    ],
  },
  {
    file: 'settings-metadata.html',
    label: 'Metadata',
    desc: 'Write NFO files and images alongside your library for third-party media servers to read.',
    keywords: 'nfo images artwork media server',
    sections: [
      {
        title: 'Kodi (XBMC) / Emby',
        desc: 'NFO and image metadata compatible with Kodi and Emby libraries.',
        keywords: 'nfo jellyfin xbmc',
        fields: [
          ['Series Metadata', null, 'nfo tvshow.nfo'],
          ['Episode Metadata', null, 'nfo'],
          ['Series Images', null, 'poster fanart artwork'],
          ['Episode Images', null, 'thumbnail artwork'],
        ],
      },
      {
        title: 'Roksbox',
        desc: 'XML metadata and thumbnails formatted for Roksbox.',
        keywords: 'xml',
        fields: [['Series Metadata'], ['Episode Metadata'], ['Series Images'], ['Episode Images']],
      },
      {
        title: 'WDTV',
        desc: 'XML metadata formatted for WD TV Live media players.',
        keywords: 'xml wd tv live',
        fields: [['Series Metadata'], ['Episode Metadata'], ['Series Images'], ['Episode Images']],
      },
    ],
  },
  {
    file: 'settings-tags.html',
    label: 'Tags',
    desc: 'Tags can be applied to series, indexers, and other settings to control automation.',
    keywords: 'tag label',
    sections: [
      {
        context: 'Tags',
        fields: [
          ['Create New Tag', null, 'add tag new'],
          ['Tag color', null, 'colour'],
          ['Tag size', 'Slider that sets how large tag chips display.', 'chip size slider'],
        ],
      },
    ],
  },
  {
    file: 'settings-general.html',
    label: 'General',
    desc: 'Networking, proxy, updates, backups, logging, and history.',
    sections: [
      {
        title: 'Host',
        desc: 'Network binding for the Kitsune web interface.',
        keywords: 'network',
        fields: [
          ['Bind Address', 'Interface Kitsune listens on.', 'ip listen interface 0.0.0.0'],
          ['Port Number', null, 'port 7879 listen'],
          ['URL Base', 'For reverse proxy setups, e.g. /kitsune.', 'reverse proxy subpath caddy nginx'],
        ],
      },
      {
        title: 'Proxy',
        keywords: 'http proxy socks network',
        fields: [
          ['Use Proxy'],
          ['Proxy Host', null, 'address'],
          ['Proxy Port'],
          ['Username', 'Proxy username.', 'login'],
          ['Password', 'Proxy password.', 'login'],
        ],
      },
      {
        title: 'Updates',
        keywords: 'update upgrade version',
        fields: [
          ['Branch', 'Which branch to check GitHub for updates against.', 'main development channel'],
          ['Automatic', 'Install updates automatically.', 'auto'],
        ],
      },
      {
        title: 'Backups',
        keywords: 'backup database',
        fields: [
          ['Folder', 'Where backups are written.', 'path directory'],
          ['Interval', 'How often to back up.', 'schedule frequency'],
          ['Retention', 'Days to keep backups before deleting.', 'keep cleanup'],
        ],
      },
      {
        title: 'Logging',
        desc: 'What System > Logs keeps, and for how long.',
        keywords: 'logs log',
        fields: [
          ['Log Level', 'Debug, Info, Warn or Error. Lower levels are discarded.', 'verbosity debug trace'],
          ['Log Retention', 'Days to keep log entries before deleting (1–365).', 'cleanup keep'],
          ['Log to File', null, 'file disk'],
        ],
      },
      {
        title: 'History',
        desc: 'Grab, import, failure and deletion events shown on Activity > History.',
        fields: [
          ['History Retention', 'Days to keep history before deleting. 0 keeps it forever.', 'cleanup keep activity'],
        ],
      },
    ],
  },
  {
    file: 'settings-security.html',
    label: 'Security',
    desc: 'Sign-in, single sign-on, and HTTPS.',
    admin: true,
    keywords: 'security login auth',
    sections: [
      {
        title: 'Authentication',
        desc: 'Require a login to access Kitsune.',
        keywords: 'login password auth',
        fields: [
          ['Authentication Method', 'None, Basic (browser popup) or Forms (login page).', 'basic forms'],
          ['Username', 'Login username.'],
          ['Password', 'Login password.'],
        ],
      },
      {
        title: 'SSL',
        desc: 'Serve the Kitsune web interface over HTTPS.',
        keywords: 'https tls certificate',
        fields: [
          ['Enable SSL'],
          ['Certificate', 'PEM-encoded certificate file.', 'cert pem'],
          ['Private Key', 'PEM-encoded private key file.', 'key pem'],
        ],
      },
      {
        title: 'Single Sign-On (OIDC)',
        desc: 'Let people sign in through an OpenID Connect provider such as Authentik, Authelia or Keycloak.',
        keywords: 'sso oidc openid oauth authentik authelia keycloak',
        fields: [
          ['Enable Single Sign-On'],
          ['Redirect URI', 'Register this exact URI as the redirect URI in your provider.', 'callback url'],
          ['Provider Name', 'Shown on the login button, e.g. "Sign in with Authentik".', 'button label'],
          ['Issuer URL', "The provider's issuer URL.", 'discovery'],
          ['Client ID'],
          ['Client Secret', 'Leave empty for a public client (PKCE only).', 'pkce'],
          ['Scopes', 'Space-separated. openid is always included.'],
          ['Username Claim', 'Claim used to name new accounts.', 'preferred_username email'],
          ['Groups Claim', null, 'groups'],
          ['Admin Group', 'Members of this group are admins and everyone else is standard, updated on every sign-in.', 'role admin'],
          ['Create Accounts Automatically', 'Create a Kitsune account the first time someone signs in through the provider.', 'auto provision'],
          ['Link Existing Accounts by Username', 'Attach a provider sign-in to an existing Kitsune account with the same username.'],
          ['Public URL', 'Only needed if the Redirect URI is wrong behind your reverse proxy.', 'reverse proxy external url'],
          ['Trusted CA Certificate', "Trust a private CA for the provider's certificate.", 'tls ca root intermediate'],
          ['Skip Certificate Verification', 'Insecure. Accepts any certificate from the provider.', 'tls insecure self-signed'],
        ],
      },
    ],
  },
  {
    file: 'settings-ui.html',
    label: 'UI',
    desc: 'Calendar, library view, date/time, and appearance preferences.',
    keywords: 'interface display appearance',
    sections: [
      {
        title: 'Calendar',
        fields: [
          ['First Day of Week', null, 'sunday monday week start'],
          ['Show Relative Dates', null, 'today tomorrow'],
          ['Collapse Multiple Episodes'],
        ],
      },
      {
        title: 'Series',
        fields: [
          ['Default Library View', 'Poster, Overview or Table.', 'library grid poster table'],
          ['Show Search Action'],
          ['Show Episode Count'],
        ],
      },
      {
        title: 'Dates & Time',
        fields: [
          ['Short Date Format', null, 'date format'],
          ['Time Format', '12 or 24 hour.', 'clock 24h 12h'],
        ],
      },
      {
        title: 'Theme',
        fields: [
          ['Theme', 'Dark, Light, OLED Black, Dusk, Paper or High Contrast.', 'appearance dark light mode oled black amoled dusk paper sepia high contrast accessibility color scheme'],
          ['Accent Color', 'Buttons, links and highlights — a preset or any custom color.', 'accent highlight color primary brand custom'],
        ],
      },
    ],
  },
  {
    file: 'settings-users.html',
    label: 'Users',
    desc: 'People who can sign in to this Kitsune server.',
    admin: true,
    keywords: 'accounts people admin',
    sections: [
      {
        context: 'Add / edit user',
        fields: [
          ['Add user', null, 'new create account'],
          ['Username'],
          ['Password', 'At least 8 characters.'],
          ['Role', 'Admin or Standard.', 'admin standard permissions'],
          ['New password', null, 'reset change'],
        ],
      },
    ],
  },
];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Flattened into one searchable entry per page, per card, and per field.
// `kind` decides how the target page locates it (see locate() in
// frontend/pages/settings-search/SettingsSearch.jsx): 'page' just opens it,
// 'section' finds the card, 'field' finds the row (falling back to its card
// when the row itself is hidden — e.g. a proxy field while Use Proxy is off).
function buildEntries() {
  const entries = [];
  for (const page of PAGES) {
    const pageKey = page.file.replace(/^settings-|\.html$/g, '');
    const base = { file: page.file, pageLabel: page.label, admin: !!page.admin };
    entries.push({
      ...base, id: pageKey, kind: 'page',
      name: page.label, section: null, card: null, desc: page.desc || '', keywords: page.keywords || '',
    });
    for (const section of page.sections) {
      const sectionLabel = section.title || section.context;
      if (section.title) {
        entries.push({
          ...base, id: `${pageKey}.${slug(section.title)}`, kind: 'section',
          name: section.title, section: null, card: section.title, desc: section.desc || '', keywords: section.keywords || '',
        });
      }
      for (const [name, desc, keywords] of section.fields) {
        entries.push({
          ...base,
          id: `${pageKey}.${slug(sectionLabel)}.${slug(name)}`,
          kind: section.title || section.targetOnPage ? 'field' : 'page',
          name, section: sectionLabel, card: section.title || null,
          // A field's own keywords count for more than the ones it inherits
          // from its section, so "sso" puts the Single Sign-On card first
          // instead of every OIDC field alphabetically.
          desc: desc || '', keywords: keywords || '', sectionKeywords: section.keywords || '',
        });
      }
    }
  }
  return entries;
}

export const SETTINGS_SEARCH_ENTRIES = buildEntries();
