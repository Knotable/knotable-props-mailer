Template.complete_profile.events({
  "submit form"(e) {
    e.preventDefault();
    Meteor.call(
      "user.update",
      {
        id: Meteor.userId(),
        firstName: e.target.firstName.value,
        lastName: e.target.lastName.value,
      },
      (err) => {
        if (err) {
          showErrorBootstrapGrowl(err.reason || err.message);
        } else {
          showBootstrapGrowl("Your profile info was updated successfully");
          Router.go("email");
        }
      }
    );
  },
});
