import { Role } from "../lib/role";

// Meteor.publish("fileByEmailEventId", function (email_event_id) {
//   if (this.userId) {
//     return Files.find({ email_event_id });
//   }
//   return [];
// });

Meteor.publish("emailEventsAndFiles", function () {
  if (this.userId) {
    emailHelperShared.maybeCreateDraftEmailForUser(this.userId);
    const findQuery = {
      user_id: this.userId,
      status: {
        $ne: EmailHelperShared.SENT,
      },
      $or: [
        { type: EmailHelperShared.DRAFT },
        { type: EmailHelperShared.ACTIVE, due_date: { $gte: new Date() } },
      ],
    };
    const emailEventCursor = EmailEvents.find(findQuery);
    let eventIds = emailEventCursor.map((event) => event._id);
    eventIds = _.uniq(eventIds);
    const fileCursor = Files.find({ email_event_id: { $in: eventIds } });
    return [emailEventCursor, fileCursor];
  }
  return [];
});

Meteor.publish("sentEmailEventsAndFiles", function () {
  if (this.userId) {
    const findQuery = {
      user_id: this.userId,
      status: EmailHelperShared.SENT,
      type: EmailHelperShared.ACTIVE,
    };
    const option = { limit: 40 };

    const emailEventCursor = EmailEvents.find(findQuery, option);
    let eventIds = emailEventCursor.map((event) => event._id);
    eventIds = _.uniq(eventIds);
    const fileCursor = Files.find({ email_event_id: { $in: eventIds } });
    return [emailEventCursor, fileCursor];
  }
  return [];
});

Meteor.publish("mailingList", function () {
  if (this.userId) {
    return MailingList.find({});
  }
  return [];
});

Meteor.publish(null, function () {
  if (!this.userId) {
    return null;
  }
  return Meteor.users.find(this.userId, {
    fields: {
      role: 1,
    },
  });
});

Meteor.publish("users", function () {
  if (!this.userId) {
    return [];
  }
  const user = Meteor.users.findOne(this.userId, { fields: { role: 1 } });
  if (user.role == Role.Admin) {
    return Meteor.users.find(
      {},
      {
        fields: {
          emails: 1,
          role: 1,
          profile: 1,
          "services.invitation": 1,
        },
      }
    );
  }
  return [];
});
