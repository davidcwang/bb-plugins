// BB remounts timeline rows while a run streams (with the Cursor provider, several
// times per tool call), and a remounted element starts its CSS animations from frame
// 0, so shimmers and loaders visibly jump back. Pinning every looping animation to
// the document clock means a remounted copy resumes exactly where the old one was.
// One-shot animations are left alone.
export function mountPhaseSync(): () => void {
  const sync = (event: AnimationEvent) => {
    const now = document.timeline.currentTime;
    if (now === null) return;
    const target = event.target as Element;
    for (const animation of target.getAnimations({ subtree: true })) {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect?.target === target && effect.getTiming().iterations === Infinity) animation.currentTime = now;
    }
  };
  document.addEventListener("animationstart", sync, true);
  return () => document.removeEventListener("animationstart", sync, true);
}
