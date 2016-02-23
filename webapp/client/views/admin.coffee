Template.admin.helpers
  domains: -> Meteor.settings.public.domains



  domain: ->
    "http://" + Session.get('selected_domain') + "/admin/master"



Template.admin.rendered = ->
  Session.set 'selected_domain', 'dev.knotable.com'
  $("#admin_frame").height $(window).height() - $(".navbar-knotable").height()
  UiHelper.showLoading()



Template.admin.events
  'load #admin_frame': ->
    UiHelper.hideLoading()
