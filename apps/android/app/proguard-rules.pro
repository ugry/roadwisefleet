# RoadwiseFleet driver app — R8 rules (board #103).
#
# Release minification is off in A1; the rules are kept so the first release
# build already has the Room/Firebase keep rules in one place.
-keep class androidx.room.** { *; }
-keep class com.elilaltd.roadwisefleet.core.data.local.** { *; }
-keep class com.google.firebase.** { *; }
