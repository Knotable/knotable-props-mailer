import { Email } from "meteor/email";
import { defaultDomainConfig } from "./mailgunDomains";

Email.customTransport = function (data) {
  return emailServerShared.sendEmail(defaultDomainConfig.domain, data);
};

Meteor.startup(() => {
  console.log("============================================");
  init_aws();
  initSlingshot();
  console.log("============================================");
});

process.on("uncaughtException", (err) => console.trace(err));
