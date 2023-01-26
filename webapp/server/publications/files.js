Meteor.publish({
  "files.get": function ({ skip, limit, sort = { createdDate: 1 } } = {}) {
    if (!this.userId) throw new Meteor.Error(401, "Unauthorized");
    return Files.find({ creatorId: this.userId }, { limit, skip, sort });
  },
});
