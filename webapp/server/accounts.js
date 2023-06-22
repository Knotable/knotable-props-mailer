import { Accounts, URLS } from "meteor/accounts-base";

Accounts.config({ forbidClientAccountCreation: true });

const { loginToken } = Accounts.urls;
Accounts.urls.loginToken = function (email) {
  //
  // Detect whether email is already encoded in case the issue will be fixed in next package releases
  // RegExp: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#description
  //
  if (/[^A-Za-z0-9-_.!~*'()]/.test(email)) {
    email = encodeURIComponent(email);
  }

  if (loginToken) {
    return loginToken.apply(this, arguments);
  }
};
