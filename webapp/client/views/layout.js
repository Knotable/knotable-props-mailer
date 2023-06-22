import { ReactiveVar } from "meteor/reactive-var";
import { Role } from "../../lib/role";
import { getDefaultAvatarUrl } from "../lib/getDefaultAvatarUrl";
import { getUserEmail } from "../lib/getUserEmail";

Template.user_loggedin.helpers({
  avatarUrl() {
    const user = Meteor.user();
    if (!user) return "";
    if (user.profile?.avatar_url) {
      return user.profile.avatar_url;
    }
    return getDefaultAvatarUrl(getUserEmail(user));
  },
});

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

Template.login.onCreated(function () {
  this.isSending = new ReactiveVar(false);
  this.isSent = new ReactiveVar(false);
});

Template.login.helpers({
  isSending() {
    return Template.instance().isSending.get();
  },
  isSent() {
    return Template.instance().isSent.get();
  },
});

Template.login.events({
  "submit form"(e, t) {
    e.preventDefault();
    t.isSending.set(true);
    Meteor.call(
      "account.requestLoginToken",
      { email: e.target.email.value },
      (err, res) => {
        t.isSending.set(false);
        if (err) {
          return showErrorBootstrapGrowl(err.reason || err.message);
        }
        t.isSent.set(true);
      }
    );
  },
});
