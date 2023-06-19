import { Role } from "../../lib/role";

Template.user_loggedin.events({
  "click #logout"() {
    return Meteor.logout(function (err) {
      if (err) {
        return console.log(err);
      }
    });
  },
});

Template.layout.helpers({
  isAdmin() {
    return Meteor.user()?.role === Role.Admin;
  },
});

Template.layout.events({
  "click a.email-tab"(e) {
    Router.go("/email");
  },

  "click a.list-tab"(e) {
    Router.go("/list");
  },

  "click a.list-users"(e) {
    Router.go("/users");
  },
});
