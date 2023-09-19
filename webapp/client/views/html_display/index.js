import { ReactiveVar } from "meteor/reactive-var";

Template.html_display.onCreated(function () {
  this.maxHeight = 300;
  this.open = new ReactiveVar(false);
  this.isLoadMore = new ReactiveVar(false);
});

Template.html_display.onRendered(function () {
  this.isLoadMore.set(this.firstNode.scrollHeight > this.maxHeight);
});

Template.html_display.helpers({
  open() {
    return Template.instance().open.get();
  },

  isLoadMore() {
    return Template.instance().isLoadMore.get();
  },

  maxHeight() {
    return Template.instance().maxHeight;
  },
});

Template.html_display.events({
  "click .show-more-less": (e, t) => {
    t.open.set(!t.open.get());
  },

  "click .fa-copy": (e, t) => {
    const type = "text/html";
    const blob = new Blob([t.data], { type });
    const data = [new ClipboardItem({ [type]: blob })];
    navigator.clipboard.write(data);
    showBootstrapGrowl("Copied to clipboard.");
  },
});
