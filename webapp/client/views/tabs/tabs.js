import { ReactiveVar } from "meteor/reactive-var";

Template.nav_tabs.onCreated(function () {
  this.tabs = [
    { name: "Compose", template: "new_email" },
    { name: "Queued", template: "email_list" },
    { name: "Sent", template: "sent_email_list" },
    { name: "Files", template: "files_list" },
  ];
  this.activeIndex = new ReactiveVar(0);
});

Template.nav_tabs.onRendered(function () {
  this.activeIndex.set(0);
});

Template.nav_tabs.helpers({
  tabs() {
    return Template.instance().tabs;
  },

  template() {
    const index = Template.instance().activeIndex.get();
    return {
      template: Template.instance().tabs[index].template,
    };
  },

  isActive(name) {
    const index = Template.instance().activeIndex.get();
    return Template.instance().tabs[index].name == name;
  },
});

Template.nav_tabs.events({
  "click a.nav-tab-item": (e, t) => {
    e.stopPropagation();
    const tabIndex = $(e.target).data().tabIndex;
    const activeIndex = t.activeIndex.get();
    if (tabIndex === activeIndex) return;
    t.activeIndex.set(tabIndex);
  },
});
