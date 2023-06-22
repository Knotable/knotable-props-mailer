import { getDefaultAvatarUrl } from "../lib/getDefaultAvatarUrl";
import { getUserEmail } from "../lib/getUserEmail";

Template.users.helpers({
  users() {
    return Meteor.users.find();
  },
});

Template.users.events({
  "click .btn-invite-user"(e) {
    const view = Blaze.renderWithData(
      Template.custom_modal,
      {
        size: "sm",
        title: "Invite User",
        template: {
          template: "invite_user",
          data: {
            user: this,
            onCancel: closeModal,
            onInvite({ email, role }) {
              Meteor.call("user.invite", { email, role }, (err) => {
                if (err) {
                  showErrorBootstrapGrowl(err.reason || err.message);
                  return;
                }
                closeModal();
              });
            },
          },
        },
        onClose: closeModal,
      },
      document.body
    );
    function closeModal() {
      if (view) {
        Blaze.remove(view);
      }
    }
  },
});

Template.platform_user.helpers({
  email() {
    return getUserEmail(this);
  },
  avatarUrl() {
    if (this.profile?.avatar_url) {
      return this.profile.avatar_url;
    }
    return getDefaultAvatarUrl(getUserEmail(this));
  },
  isCurrentUser() {
    return this._id == Meteor.userId();
  },
  hasPendingInvitation() {
    return !!this.services?.invitation;
  },
});

Template.platform_user.events({
  "click .btn-change-user-role"(e) {
    const selectedRole = e.target.getAttribute("data-value");
    if (this.role !== selectedRole) {
      Meteor.call(
        "user.updateRole",
        { id: this._id, role: selectedRole },
        (err) => {
          if (err) {
            showErrorBootstrapGrowl(err.reason || err.message);
          }
        }
      );
    }
  },
  "click .btn-remove-user"() {
    const view = Blaze.renderWithData(
      Template.custom_modal,
      {
        size: "sm",
        title: "Remove User",
        template: {
          template: "remove_user_confirmation",
          data: {
            user: this,
            onCancel: closeModal,
            onRemove(user) {
              Meteor.call("user.remove", { id: user._id }, (err) => {
                if (err) {
                  showErrorBootstrapGrowl(err.reason || err.message);
                  return;
                }
                closeModal();
              });
            },
          },
        },
        onClose: closeModal,
      },
      document.body
    );
    function closeModal() {
      if (view) {
        Blaze.remove(view);
      }
    }
  },
});

Template.invite_user.events({
  "click .btn-cancel"(e, t) {
    const { onCancel } = t.data;
    if (typeof onCancel == "function") {
      onCancel();
    }
  },
  "submit form"(e, t) {
    e.preventDefault();
    const { onInvite } = t.data;
    if (typeof onInvite == "function") {
      onInvite({
        email: e.target.email.value,
        role: e.target.role.value,
      });
    }
  },
});

Template.remove_user_confirmation.helpers({
  userNameOrEmail() {
    return this.user.profile?.name || getUserEmail(this.user);
  },
});

Template.remove_user_confirmation.events({
  "click .btn-cancel"(e, t) {
    const { onCancel } = t.data;
    if (typeof onCancel == "function") {
      onCancel();
    }
  },
  "click .btn-remove"(e, t) {
    const { onRemove } = t.data;
    if (typeof onRemove == "function") {
      onRemove(this.user);
    }
  },
});
