import { ReactiveVar } from "meteor/reactive-var";

Template.files_list.onCreated(function () {
  this.files = new ReactiveVar([]);
  this.isLoading = new ReactiveVar(false);
});

Template.files_list.onRendered(function () {
  this.isLoading.set(true);
  Meteor.call("getUserFiles", (err, res) => {
    if (res) this.files.set(res);
    this.isLoading.set(false);
  });
});

Template.files_list.helpers({
  isLoading() {
    return Template.instance().isLoading.get();
  },

  files() {
    return Template.instance().files.get();
  },
});

Template.file_item.helpers({
  size() {
    return FileHelper.fileSize2Text(this.size);
  },
});
