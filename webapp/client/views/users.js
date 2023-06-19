function stringToColor(string) {
  let hash = 0;
  let i;
  for (i = 0; i < string.length; i += 1) {
    hash = string.charCodeAt(i) + ((hash << 5) - hash);
  }
  let color = "#";
  for (i = 0; i < 3; i += 1) {
    const value = (hash >> (i * 8)) & 0xff;
    color += `00${value.toString(16)}`.slice(-2);
  }
  return color;
}

function getUserEmail(user) {
  return (user.emails && user.emails[0]?.address) || user.profile.email;
}

function getDefaultAvatarUrl(email) {
  const color = stringToColor(email);
  const svg = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <g id="avatar" transform="translate(-1407 -182)">
  <circle cx="15" cy="15" r="15" transform="translate(1408 183)" fill="${color}" stroke="#333" stroke-linecap="round" stroke-linejoin="round" stroke-width="0.9"></circle>
  <circle cx="4.565" cy="4.565" r="4.565" transform="translate(1418.435 192.13)" fill="#ffffff" stroke="#333" stroke-miterlimit="10" stroke-width="0.9"></circle>
  <path d="M1423,213a14.928,14.928,0,0,0,9.4-3.323,9.773,9.773,0,0,0-18.808,0A14.928,14.928,0,0,0,1423,213Z" fill="#ffffff" stroke="#333" stroke-miterlimit="10" stroke-width="0.9"></path>
  </g></svg>`;
  const svgDataBase64 = btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;charset=utf-8;base64,${svgDataBase64}`;
}

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
