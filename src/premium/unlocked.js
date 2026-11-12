// Local build: the license/trial system was removed (2026-11-11). Feature
// modules still ask window.__xvmPro which tier is active, so this stub
// answers "pro" for everything and never contacts any server.
(() => {
  if (window.__xvmPro) return;
  window.__xvmPro = {
    getCurrentTier: () => 'pro',
    getTrialDaysLeft: () => 0,
    getTierSource: () => 'local-unlocked',
    isFeatureEnabled: () => true,
    onTierChange: () => {},
  };
})();
