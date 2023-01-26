import { ReactiveVar } from "meteor/reactive-var";

Template.files_list.onCreated(function () {
  this.sort = { ceratedDate: 1 };
  this.isLoading = new ReactiveVar(false);
});

Template.files_list.onRendered(function () {
  this.autorun(() => {
    this.isLoading.set(true);
    Meteor.subscribe(
      "files.get",
      { sort: this.sort },
      {
        onStop: (err) => {
          if (err) showBootstrapGrowl(err.reason ?? err.message);
          this.isLoading.set(false);
        },
        onReady: () => {
          this.isLoading.set(false);
        },
      }
    );
  });
});

Template.files_list.helpers({
  isLoading() {
    return Template.instance().isLoading.get();
  },

  template() {
    const { template } = Template.parentData() ?? {};
    return template ?? "file_item";
  },

  files() {
    const { sort } = Template.instance();
    return Files.find({ creatorId: Meteor.userId() }, { sort });
  },
});

Template.files_list.events({
  "click .file-item_1[data-file-id]": (e, t) => {
    const fileId = e.currentTarget.dataset?.fileId;
    const file = Files.findOne(fileId);
    const { onClick } = t.data;
    if (file && typeof onClick === "function") {
      onClick(file);
    }
  },

  "click .file-item[data-file-id] .file-actions button.delete": (e, t) => {
    const el = e.target.closest(".file-item");
    const fileId = el.dataset?.fileId;
    if (!fileId) return;
    Meteor.call("files.delete", [fileId], (err, res) => {
      if (err) showBootstrapGrowl(err.reason ?? err.message);
    });
  },
});
