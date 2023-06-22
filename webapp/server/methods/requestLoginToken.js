import { Accounts } from "meteor/accounts-base";
import { Meteor } from "meteor/meteor";

const _1_MINUTE = 60 * 1000;
const _10_MINUTES = 10 * _1_MINUTE;

Meteor.methods({
  "account.requestLoginToken"({ email }) {
    this.unblock();

    const user = Accounts.findUserByEmail(email, {
      fields: { services: 1 },
    });

    if (!user) {
      throw new Meteor.Error(404, "User not found");
    }

    const { createdAt, token } = user.services?.passwordless ?? {};

    if (createdAt && token) {
      const time = createdAt.getTime() + _10_MINUTES - new Date().getTime();
      if (time > 0) {
        throw new Meteor.Error(403, "Login token is requested already", {
          retry: time,
        });
      }
    }

    return Meteor.call("requestLoginTokenForUser", {
      selector: { email },
      userData: {},
      options: {
        userCreationDisabled: true,
        extra: {
          template: {
            name: "sendLoginToken",
            subject: "One time login link",
          },
        },
      },
    });
  },
});
