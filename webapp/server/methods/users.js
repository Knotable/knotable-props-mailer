import { Accounts } from "meteor/accounts-base";
import { Role } from "../../lib/role";
import {
  notEmptyDocumentIdMatcher,
  notEmptyStringMatcher,
} from "../helpers/matchers";

function authorize(userId) {
  const error = new Meteor.Error(403, "Unauthorized");
  if (!userId) {
    throw error;
  }
  const user = Meteor.users.findOne(userId, { fields: { role: 1 } });
  if (user?.role != Role.Admin) {
    throw error;
  }
}

Meteor.methods({
  "user.invite"({ email, role } = {}) {
    authorize(this.userId);
    if (!ValidationsHelper.isCorrectEmail(email)) {
      throw new Meteor.Error(400, "Invalid email address");
    }
    if (!Object.values(Role).includes(role)) {
      throw new Meteor.Error(400, "Invalid user role");
    }
    const userId = Accounts.createUser({ email });
    Meteor.users.update(userId, {
      $set: {
        role,
        "services.invitation": {
          invitedDate: new Date(),
          userId: this.userId,
        },
      },
    });
    const currentUser = Meteor.users.findOne(this.userId, {
      fields: { profile: 1 },
    });

    Meteor.call("requestLoginTokenForUser", {
      selector: { id: userId },
      userData: {},
      options: {
        userCreationDisabled: true,
        extra: {
          template: {
            name: "inviteUser",
            subject: `${currentUser.profile.name} invited you to Kmail`,
          },
        },
      },
    });
  },

  "user.updateRole"({ id, role } = {}) {
    authorize(this.userId);
    if (this.userId == id) {
      throw new Meteor.Error(
        403,
        "You're not authorized to update your own role"
      );
    }
    if (!Object.values(Role).includes(role)) {
      throw new Meteor.Error(400, "Invalid user role");
    }
    Meteor.users.update(id, { $set: { role } });
  },

  "user.update"({ id, firstName, lastName } = {}) {
    check(id, notEmptyDocumentIdMatcher());
    check(firstName, notEmptyStringMatcher());
    check(lastName, notEmptyStringMatcher());

    if (this.userId != id) {
      authorize(this.userId);
    }
    Meteor.users.update(
      { _id: id },
      {
        $set: {
          "profile.firstName": firstName,
          "profile.lastName": lastName,
          "profile.name": `${firstName} ${lastName}`.trim(),
        },
        $unset: {
          "services.invitation": 1,
        },
      }
    );
  },

  "user.remove"({ id } = {}) {
    authorize(this.userId);
    if (this.userId == id) {
      throw new Meteor.Error(403, "You're not authorized to remove yourself");
    }
    Meteor.users.remove({ _id: id });
  },
});
