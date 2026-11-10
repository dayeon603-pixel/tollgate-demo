// Applied before first paint so a hidden sidebar does not flash in.
try { if (localStorage.getItem('tg.side') === 'hidden' && !matchMedia('(max-width: 900px)').matches) document.documentElement.dataset.side = 'hidden'; } catch (e) { /* storage blocked */ }
