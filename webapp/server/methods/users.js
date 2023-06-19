import { Accounts } from "meteor/accounts-base";
import { Role } from "../../lib/role";
import { defaultDomainConfig } from "../mailgunDomains";

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
        },
      },
    });
    const currentUser = Meteor.users.findOne(this.userId, {
      fields: { profile: 1 },
    });
    emailServerShared.sendEmail(defaultDomainConfig.domain, {
      to: email,
      from: `noreply@${defaultDomainConfig.domain}`,
      subject: `${currentUser.profile.name} invited you to Kmail`,
      text: `Hello!

      ${currentUser.profile.name} sent you an invitation to Kmail service.

      To accept this invitation follow the link below.

      ${Meteor.absoluteUrl(`invitation/${userId}`)}

      Sincerely,
      Kmail team`,
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

  "user.remove"({ id } = {}) {
    authorize(this.userId);
    if (this.userId == id) {
      throw new Meteor.Error(403, "You're not authorized to remove yourself");
    }
    Meteor.users.remove({ _id: id });
  },
});
