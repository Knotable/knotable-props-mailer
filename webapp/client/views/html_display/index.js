import { ReactiveVar } from "meteor/reactive-var";
import copy from "copy-to-clipboard";

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

  "click .fa-copy": async (e, t) => {
    if (copy(t.data, { format: "text/html" }))
      showBootstrapGrowl("Copied to clipboard.");
  },
});
