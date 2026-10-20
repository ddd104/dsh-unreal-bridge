import packageInfo from '../package.json' with {type:'json'};

/** One projection for both Remote UI and model tools. Never scans disk. */
export function createStateService(bridge,guard,getConfig) {
  return sessionId=>{
    const executionSafety=guard.status(sessionId);
    const config=getConfig();
    const nextTurnSettings=Object.fromEntries(Object.entries(config).filter(([key])=>key.startsWith('guard')));
    const settingsPending=!!executionSafety?.active&&Object.entries(nextTurnSettings).some(([key,value])=>executionSafety.limits[key]!==value);
    return {
      ...bridge.state(sessionId),executionSafety,
      settings:{nextTurnPending:settingsPending,nextTurnLimits:nextTurnSettings},
      visualTools:{hostVersion:packageInfo.version,revision:2,analyses:['spatial','color_distribution'],signedZeroNormalized:true},
    };
  };
}
