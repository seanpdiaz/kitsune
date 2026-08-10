// ---------------------------------------------------------------------------
// A 3-handle range slider: minimum / preferred (target) / maximum, plus an
// "Unlimited" toggle for the max handle. Built by hand with pointer events
// rather than <input type="range">, since the native element only ever
// supports one handle (two with some browser-specific tricks, never three) —
// see README's Quality Definitions section for why Settings > Quality needed
// this instead of the old three-separate-number-boxes layout.
//
// Each of the three settings pages/rows that use this gets its own mounted
// instance (mountRangeSlider is a factory, not a singleton), all sharing the
// same drag/keyboard/tooltip logic — one component instead of three copies
// of near-identical pointer-event code, the same instinct this project has
// applied to file-browser-modal.js/release-picker-modal.js.
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// mountRangeSlider(container, options) -> controller
//   options.min / options.max   — the slider's own absolute bounds (the raw
//                                 canonical unit, e.g. 0..2000 MB/min)
//   options.step                — snap increment (default 1)
//   options.value                — { min, preferred, max, maxUnlimited }
//   options.format(rawValue)     — formats a raw value for tooltips/labels
//   options.parse(text, defaultUnit) — reverses format(): turns a handle's
//                                  typed edit box text back into a raw
//                                  value. defaultUnit is the unit suffix the
//                                  box was pre-filled with (e.g. "GB"), for
//                                  when the typed text is a bare number with
//                                  no suffix of its own — see openEditor.
//                                  Falls back to a plain numeric strip if
//                                  omitted. See commitTypedValue below.
//   options.onChange(value)      — fires on every drag move / keyboard nudge
//   options.onCommit(value)      — fires once when a drag ends, a key is
//                                  released, or a typed edit commits — the
//                                  right place to hook a save
function mountRangeSlider(container, options) {
  const bounds = { min: options.min, max: options.max };
  const step = options.step || 1;
  const format = options.format || ((v) => String(v));
  const state = {
    min: clamp(options.value.min, bounds.min, bounds.max),
    preferred: clamp(options.value.preferred, bounds.min, bounds.max),
    max: clamp(options.value.max, bounds.min, bounds.max),
    maxUnlimited: !!options.value.maxUnlimited,
  };

  // The smallest allowed min-to-preferred or preferred-to-max distance, as a
  // fraction of the track's own range rather than a fixed raw number — a
  // fixed gap would be generous on a small SDTV-scale track and invisible on
  // a huge 2160p-scale one, since pct() maps the value range onto the same
  // 0-100% either way. Without this, min could be dragged (or typed) all the
  // way up to exactly equal preferred — same for max down to preferred —
  // and since preferred renders on top (higher z-index, see styles.css),
  // the other handle ends up pixel-for-pixel underneath it: invisible, and
  // with no way to grab it again since preferred captures every click at
  // that spot. Every path that can move min/max (drag, keyboard nudge, a
  // typed edit, and un-toggling Unlimited) is routed through this so none
  // of them can reintroduce that trap.
  function minGap() {
    return Math.max(step, (bounds.max - bounds.min) * 0.03);
  }
  function enforceGaps() {
    const gap = minGap();
    if (state.preferred - state.min < gap) state.min = Math.max(bounds.min, state.preferred - gap);
    if (!state.maxUnlimited && state.max - state.preferred < gap) state.max = Math.min(bounds.max, state.preferred + gap);
  }
  enforceGaps();

  container.innerHTML = `
    <div class="rs-wrap">
      <div class="rs-track">
        <div class="rs-track-fill"></div>
        <div class="rs-handle rs-handle-min" tabindex="0" role="slider" aria-label="Minimum size">
          <div class="rs-tooltip"></div>
          <input class="rs-edit-input" type="text" inputmode="decimal" aria-label="Edit minimum size" />
        </div>
        <div class="rs-handle rs-handle-preferred" tabindex="0" role="slider" aria-label="Preferred (target) size">
          <div class="rs-tooltip"></div>
          <input class="rs-edit-input" type="text" inputmode="decimal" aria-label="Edit target size" />
        </div>
        <div class="rs-handle rs-handle-max" tabindex="0" role="slider" aria-label="Maximum size">
          <div class="rs-tooltip"></div>
          <input class="rs-edit-input" type="text" inputmode="decimal" aria-label="Edit maximum size" />
        </div>
      </div>
      <div class="rs-labels">
        <span class="rs-label-min"></span>
        <span class="rs-label-max-group">
          <span class="rs-label-max-text"></span>
          <button type="button" class="rs-unlimited-btn" aria-pressed="false">&infin; Unlimited</button>
        </span>
      </div>
    </div>
  `;

  const track = container.querySelector('.rs-track');
  const fill = container.querySelector('.rs-track-fill');
  const handleMin = container.querySelector('.rs-handle-min');
  const handlePreferred = container.querySelector('.rs-handle-preferred');
  const handleMax = container.querySelector('.rs-handle-max');
  const labelMin = container.querySelector('.rs-label-min');
  const labelMaxText = container.querySelector('.rs-label-max-text');
  const unlimitedBtn = container.querySelector('.rs-unlimited-btn');

  function pct(v) {
    return ((clamp(v, bounds.min, bounds.max) - bounds.min) / (bounds.max - bounds.min || 1)) * 100;
  }

  function render() {
    const minPct = pct(state.min);
    const maxPct = state.maxUnlimited ? 100 : pct(state.max);
    handleMin.style.left = minPct + '%';
    handlePreferred.style.left = pct(state.preferred) + '%';
    handleMax.style.left = maxPct + '%';
    handleMax.classList.toggle('rs-unlimited', state.maxUnlimited);
    fill.style.left = minPct + '%';
    fill.style.right = (100 - maxPct) + '%';

    handleMin.querySelector('.rs-tooltip').textContent = `${format(state.min)} (minimum)`;
    handlePreferred.querySelector('.rs-tooltip').textContent = `${format(state.preferred)} (target)`;
    handleMax.querySelector('.rs-tooltip').textContent = state.maxUnlimited ? 'Unlimited' : `${format(state.max)} (maximum)`;

    labelMin.textContent = `${format(state.min)} (Min)`;
    labelMaxText.textContent = state.maxUnlimited ? 'Unlimited' : `${format(state.max)} (Max)`;
    labelMaxText.classList.toggle('is-unlimited', state.maxUnlimited);
    unlimitedBtn.setAttribute('aria-pressed', String(state.maxUnlimited));
  }

  function snap(v) {
    return Math.round(v / step) * step;
  }

  function valueFromClientX(clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return snap(bounds.min + ratio * (bounds.max - bounds.min));
  }

  function clampForHandle(which, v) {
    const gap = minGap();
    if (which === 'min') return clamp(v, bounds.min, Math.max(bounds.min, state.preferred - gap));
    return clamp(v, Math.min(bounds.max, state.preferred + gap), bounds.max); // 'max'
  }

  // Translates the whole min/preferred/max window so that whichever of the
  // three points is named by `anchor` lands at `anchorValue`, while min and
  // max *try* to keep their current distance from preferred — i.e. the
  // window moves as close to a rigid unit as it can.
  //
  // "As close as it can" rather than always-rigid on purpose: the earlier
  // version derived preferred's own floor/ceiling directly from min/max's
  // CURRENT distance from it, which broke down the moment either one was
  // already sitting at its own real limit (0 for min, the track's top for
  // max). Once min was at 0, its distance from preferred *is* preferred's
  // own current value — so that floor silently became "preferred can never
  // decrease," blocking every attempt to lower the target, by drag,
  // keyboard, or typing, for as long as min stayed at 0 (reported as: drag
  // the target left when min is 0, and nothing happens). Instead, min and
  // max now each independently clamp against their own real limits and
  // minGap() from wherever preferred actually ends up — so if preserving
  // the old gap isn't possible without going negative, that edge just
  // sticks at its limit (the gap shrinks) instead of the whole translate
  // refusing to happen.
  //
  // `clampToTrack` controls whether preferred's landing spot is additionally
  // capped at the *rendered* track's pixel bounds. That cap makes sense for
  // a drag or a keyboard nudge — you physically can't drag a handle past
  // the edge of its own track — but not for a typed value: `bounds` here is
  // just boundsForTier()'s guess at a track width for the *previous* values
  // (see README's bounds-recalculation note), not a real limit on the data,
  // and there's no pixel being dragged for a typed number to run out of.
  // Typed commits (see commitTypedValue below) pass clampToTrack=false so
  // the exact number typed always wins, uncapped in both directions; the
  // track then resizes to fit once the caller re-renders after the commit
  // (settings-quality.js's renderAll(), or QualityTierRow's key-based
  // remount in the React port — see README's "React migration" section).
  function translateWindowTo(anchor, anchorValue, clampToTrack) {
    const gap = minGap();
    const minOffset = state.preferred - state.min;
    const maxOffset = state.max - state.preferred;
    let newPreferred;
    if (anchor === 'preferred') newPreferred = anchorValue;
    else if (anchor === 'min') newPreferred = anchorValue + minOffset;
    else newPreferred = anchorValue - maxOffset; // 'max'
    if (clampToTrack) {
      const hi = state.maxUnlimited ? bounds.max : bounds.max - gap;
      newPreferred = clamp(newPreferred, bounds.min + gap, Math.max(bounds.min + gap, hi));
    }
    newPreferred = Math.max(newPreferred, gap); // min must have room to sit at >= 0, minGap() below preferred
    state.preferred = newPreferred;
    state.min = clamp(newPreferred - minOffset, 0, newPreferred - gap);
    if (!state.maxUnlimited) {
      const maxCeiling = clampToTrack ? bounds.max : Infinity;
      state.max = clamp(newPreferred + maxOffset, newPreferred + gap, Math.max(newPreferred + gap, maxCeiling));
    }
  }
  const moveWindow = (newPreferred) => translateWindowTo('preferred', newPreferred, true);

  // Applies a value typed into a handle's edit box (see dblclick wiring
  // below). Preferred always translates the whole window. Min/max only
  // translate the window when the typed number would land within minGap()
  // of preferred (crossing it, or just landing too close) — otherwise it's
  // a plain resize of that one edge, same as dragging that handle already
  // does. This is what lets typing an intentional number always win
  // outright: crossing the old target doesn't silently get clamped back
  // down to it, it carries the target (and the far edge) along, preserving
  // whatever gap they had — and, unlike a drag, isn't capped by the current
  // track's pixel width either (clampToTrack=false above). Routing the
  // too-close case through the same translate as an outright crossing (not
  // just resize-then-clamp) keeps a typed edit from ever landing exactly on
  // top of preferred the way a drag used to be able to (see minGap above).
  function commitTypedValue(which, rawValue) {
    const v = Math.max(0, snap(rawValue));
    const gap = minGap();
    if (which === 'preferred') { translateWindowTo('preferred', v, false); return; }
    if (which === 'min') {
      if (v <= state.preferred - gap) state.min = v;
      else translateWindowTo('min', v, false);
      return;
    }
    if (state.maxUnlimited) return; // nothing numeric to type over
    if (v >= state.preferred + gap) state.max = v;
    else translateWindowTo('max', v, false);
  }

  function startDrag(which, handleEl) {
    return (e) => {
      if (which === 'max' && state.maxUnlimited) return;
      // Deliberately NOT calling e.preventDefault() here. Per the Pointer
      // Events spec, canceling a pointerdown suppresses the browser's
      // synthesized compatibility mouse events for it — including click and
      // dblclick — which silently broke the double-click-to-edit feature
      // below (a real double-click never produced a dblclick event at all,
      // even though a jsdom test dispatching a synthetic 'dblclick' directly
      // passed, since that bypasses this pointer-to-mouse pipeline
      // entirely). Text selection during a drag is prevented by
      // `user-select: none` on .rs-handle in styles.css instead; touch
      // scrolling is already prevented by `touch-action: none` there too —
      // neither actually needed preventDefault on pointerdown to begin with.
      handleEl.classList.add('rs-dragging');
      handleEl.focus();
      // A plain click (no movement) still runs this whole handler — up()
      // fires on every pointerup regardless of whether anything moved.
      // That used to be harmless (onCommit only did an idempotent PATCH),
      // but the caller's onCommit now also re-renders on every commit (see
      // the bounds-recompute fix above — settings-quality.js's renderAll(),
      // or the React port's key-based row remount), which tears down and
      // rebuilds this handle's DOM node. Firing that
      // on every click — including the first click of a double-click —
      // replaces the handle mid-interaction, so the second click lands on a
      // brand new element the browser never saw the first click on, and
      // never registers as a double-click at all. Snapshotting the value at
      // pointerdown and only firing onCommit if it actually changed avoids
      // rebuilding anything for a no-op click.
      const initial = { ...state };
      const move = (ev) => {
        const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const rawV = valueFromClientX(clientX);
        if (which === 'preferred') moveWindow(rawV);
        else state[which] = clampForHandle(which, rawV);
        render();
        if (options.onChange) options.onChange({ ...state });
      };
      const changed = () => (
        state.min !== initial.min || state.preferred !== initial.preferred ||
        state.max !== initial.max || state.maxUnlimited !== initial.maxUnlimited
      );
      const up = () => {
        handleEl.classList.remove('rs-dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (options.onCommit && changed()) options.onCommit({ ...state });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  }
  handleMin.addEventListener('pointerdown', startDrag('min', handleMin));
  handlePreferred.addEventListener('pointerdown', startDrag('preferred', handlePreferred));
  handleMax.addEventListener('pointerdown', startDrag('max', handleMax));

  // Keyboard: focus a handle (native tab order via tabindex above), then
  // Left/Down and Right/Up nudge it by one step — the same drag clamping
  // rules apply so a keyboard user can't push min past preferred either.
  // Nudging the preferred handle translates the whole window, same as
  // dragging it does (see moveWindow above).
  function wireKeyboard(handleEl, which) {
    handleEl.addEventListener('keydown', (e) => {
      if (which === 'max' && state.maxUnlimited) return;
      let delta = 0;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step;
      else return;
      e.preventDefault();
      if (which === 'preferred') moveWindow(state.preferred + delta);
      else state[which] = clampForHandle(which, state[which] + delta);
      render();
      if (options.onChange) options.onChange({ ...state });
      if (options.onCommit) options.onCommit({ ...state });
    });
  }
  wireKeyboard(handleMin, 'min');
  wireKeyboard(handlePreferred, 'preferred');
  wireKeyboard(handleMax, 'max');

  // Double-click a handle to type an exact value instead of dragging —
  // dragging is fine for a rough position but can't hit an exact number,
  // especially on a track sized for a very different tier. Each handle gets
  // its own small text input (hidden until opened), pre-filled with the
  // handle's current value through the same format() the tooltip uses, so
  // what's shown matches what you type back. options.parse(text) does the
  // reverse conversion (page-specific — it knows about display unit/
  // reference runtime); commitTypedValue above decides whether that's a
  // plain resize of one edge or a whole-window translate.
  const editInputs = {
    min: handleMin.querySelector('.rs-edit-input'),
    preferred: handlePreferred.querySelector('.rs-edit-input'),
    max: handleMax.querySelector('.rs-edit-input'),
  };
  const handles = { min: handleMin, preferred: handlePreferred, max: handleMax };
  const parse = options.parse || ((text) => parseFloat(String(text).replace(/[^0-9.\-]/g, '')));

  function openEditor(which) {
    if (which === 'max' && state.maxUnlimited) return;
    const input = editInputs[which];
    const prefill = format(state[which]);
    input.value = prefill;
    // Remember the unit the pre-filled value was shown in (e.g. "GB" out of
    // "1.48 GB") so a bare number typed over it defaults back to that same
    // unit instead of some fixed fallback. Selecting all and retyping just
    // the number — leaving the unit off entirely — is the expected way to
    // edit this box, so the default has to track whatever was actually
    // shown, not guess independently. Getting this wrong is exactly how
    // typing "3" meaning "3 GB" over a prefilled "1.48 GB" was silently read
    // back as 3 *MB* instead — see README's Quality Definitions section.
    input.dataset.defaultUnit = (prefill.match(/[a-zA-Z/]+$/) || [''])[0];
    handles[which].classList.add('rs-editing');
    input.focus();
    input.select();
  }
  function closeEditor(which) {
    handles[which].classList.remove('rs-editing');
  }
  function commitEditor(which) {
    const input = editInputs[which];
    const raw = parse(input.value, input.dataset.defaultUnit);
    closeEditor(which);
    if (raw === null || raw === undefined || Number.isNaN(raw)) return;
    commitTypedValue(which, raw);
    render();
    if (options.onChange) options.onChange({ ...state });
    if (options.onCommit) options.onCommit({ ...state });
  }

  ['min', 'preferred', 'max'].forEach((which) => {
    handles[which].addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor(which);
    });
    const input = editInputs[which];
    // Stop the input's own pointerdown/click from bubbling up to the
    // handle's drag-start listener (see startDrag above) — otherwise
    // clicking into the box to edit its text would also try to start a drag.
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't let arrow keys also nudge the handle while typing
      if (e.key === 'Enter') { e.preventDefault(); commitEditor(which); }
      else if (e.key === 'Escape') { e.preventDefault(); closeEditor(which); }
    });
    input.addEventListener('blur', () => commitEditor(which));
  });

  // A toggle button, not a checkbox — flips its own pressed state on click
  // rather than relying on a separate input the user has to notice next to
  // the label text (see README's Quality Definitions section for why this
  // changed from the original checkbox).
  unlimitedBtn.addEventListener('click', () => {
    state.maxUnlimited = !state.maxUnlimited;
    if (!state.maxUnlimited) state.max = clamp(state.max, Math.min(bounds.max, state.preferred + minGap()), bounds.max);
    render();
    if (options.onChange) options.onChange({ ...state });
    if (options.onCommit) options.onCommit({ ...state });
  });

  render();

  return {
    getValue: () => ({ ...state }),
    setValue: (v) => {
      state.min = clamp(v.min, bounds.min, bounds.max);
      state.preferred = clamp(v.preferred, bounds.min, bounds.max);
      state.max = clamp(v.max, bounds.min, bounds.max);
      state.maxUnlimited = !!v.maxUnlimited;
      enforceGaps(); // defensive: in case the incoming value itself violates minGap
      render();
    },
    setBounds: (newMin, newMax) => {
      bounds.min = newMin;
      bounds.max = newMax;
      enforceGaps(); // the gap is a fraction of the range, so new bounds can shrink it
      render();
    },
  };
}

export { mountRangeSlider };
