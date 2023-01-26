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
    const file = Template.currentData();
    const { template, ...rest } = Template.parentData() ?? {};
    return {
      template: template ?? "file_item",
      data: { ...rest, ...file },
    };
  },

  files() {
    const { sort } = Template.instance();
    return Files.find({ creatorId: Meteor.userId() }, { sort });
  },
});
