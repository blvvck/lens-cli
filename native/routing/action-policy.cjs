function buildActionPolicy(args) {
  const a = args || {};
  const waitReady = a["wait-ready"] ?? a.waitReady;
  const verify = a.verify;
  const verifySelector = a["verify-selector"] ?? a.verifySelector;
  const verifyText = a["verify-text"] ?? a.verifyText;
  const verifyTimeout = a["verify-timeout"] ?? a.verifyTimeout;
  const retry = a.retry;
  const retryDelay = a["retry-delay"] ?? a.retryDelay;
  const scroll =
    typeof a.scroll === "string" ? a.scroll.toLowerCase() : undefined;

  return {
    ...(waitReady === true ? { waitReady: true } : {}),
    ...(verify !== undefined && verify !== false ? { verify } : {}),
    ...(verifySelector !== undefined ? { verifySelector } : {}),
    ...(verifyText !== undefined ? { verifyText } : {}),
    ...(verifyTimeout !== undefined ? { verifyTimeout } : {}),
    ...(retry !== undefined ? { retry } : {}),
    ...(retryDelay !== undefined ? { retryDelay } : {}),
    ...(scroll === "auto" || scroll === "off" ? { scroll } : {}),
  };
}

module.exports = buildActionPolicy;
