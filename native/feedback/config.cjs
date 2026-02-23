"use strict";

const DEFAULT_FEEDBACK_API = "https://api.lenscli.com";

function getFeedbackBaseUrl(env = process.env) {
  const keys = [
    "LENS_FEEDBACK_API",
    "LENS_FEEDBACK_URL",
    "LENS_FEEDBACK_ENDPOINT",
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      const value = env[key];
      return value ? String(value).trim() : null;
    }
  }

  return DEFAULT_FEEDBACK_API;
}

module.exports = {
  DEFAULT_FEEDBACK_API,
  getFeedbackBaseUrl,
};
