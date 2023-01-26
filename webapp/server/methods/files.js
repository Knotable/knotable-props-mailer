import FilesService from "../services/files";

Meteor.methods({
  "files.get": ({ skip, limit } = {}) => {
    if (!Meteor.userId()) throw new Meteor.Error(401, "Unauthorized");
    return FilesService.createDefault().get(
      { creatorId: Meteor.userId() },
      { skip, limit }
    );
  },

  "files.delete": (fileIds) => {
    if (Meteor.userId()) throw new Meteor.Error(401, "Unauthorized");
    return FilesService.createDefault().delete({
      creatorId: Meteor.userId(),
      fileIds,
    });
  },
});
