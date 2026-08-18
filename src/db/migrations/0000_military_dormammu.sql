CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"hard" jsonb NOT NULL,
	"soft" jsonb NOT NULL,
	"notify" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"raw_text" text,
	"rent_base" numeric(10, 2) NOT NULL,
	"parking_included" boolean,
	"parking_cost" numeric(10, 2),
	"utilities_included" text[] DEFAULT '{}' NOT NULL,
	"total_monthly_cost" numeric(10, 2) NOT NULL,
	"beds" integer,
	"dens" integer DEFAULT 0 NOT NULL,
	"baths" numeric(3, 1),
	"has_locker" boolean,
	"in_suite_laundry" boolean,
	"address" text,
	"city" text,
	"lat" double precision,
	"lng" double precision,
	"available_from" date,
	"building_built_before_2018" boolean,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hydrated_at" timestamp with time zone,
	"delisted_at" timestamp with time zone,
	"missed_sweeps" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "listings_source_source_id_key" UNIQUE("source","source_id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"score" double precision NOT NULL,
	"breakdown" jsonb NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_listing_profile_key" UNIQUE("listing_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"listing_id" uuid,
	"score" double precision NOT NULL,
	"telegram_message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_profile_fingerprint_key" UNIQUE("profile_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "geocode_cache" (
	"query_hash" text PRIMARY KEY NOT NULL,
	"raw_query" text NOT NULL,
	"lat" text,
	"lng" text,
	"provider" text NOT NULL,
	"miss" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "needs_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"field" text NOT NULL,
	"reason" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejection_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" text NOT NULL,
	"listing_id" uuid,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"url" text,
	"reason" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daycares" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"auspice" text,
	"address" text,
	"postal_code" text,
	"ward" text,
	"phone" text,
	"building_type" text,
	"building_name" text,
	"infant_space" integer DEFAULT 0 NOT NULL,
	"toddler_space" integer DEFAULT 0 NOT NULL,
	"preschool_space" integer DEFAULT 0 NOT NULL,
	"kindergarten_space" integer DEFAULT 0 NOT NULL,
	"schoolage_space" integer DEFAULT 0 NOT NULL,
	"total_space" integer DEFAULT 0 NOT NULL,
	"subsidy" boolean DEFAULT false NOT NULL,
	"cwelcc" boolean DEFAULT false NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"source_run_date" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transit_stations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"line" text NOT NULL,
	"status" text NOT NULL,
	"mode" text NOT NULL,
	"expected_year" integer,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_review" ADD CONSTRAINT "needs_review_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_review" ADD CONSTRAINT "needs_review_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejection_log" ADD CONSTRAINT "rejection_log_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejection_log" ADD CONSTRAINT "rejection_log_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_fingerprint_idx" ON "listings" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "listings_last_seen_idx" ON "listings" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "matches_profile_score_idx" ON "matches" USING btree ("profile_id","score");--> statement-breakpoint
CREATE INDEX "needs_review_open_idx" ON "needs_review" USING btree ("profile_id","resolved_at");--> statement-breakpoint
CREATE INDEX "rejection_log_profile_reason_idx" ON "rejection_log" USING btree ("profile_id","reason");--> statement-breakpoint
CREATE INDEX "rejection_log_created_idx" ON "rejection_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "daycares_toddler_idx" ON "daycares" USING btree ("toddler_space");--> statement-breakpoint
CREATE INDEX "daycares_cwelcc_idx" ON "daycares" USING btree ("cwelcc");--> statement-breakpoint
CREATE INDEX "transit_stations_status_idx" ON "transit_stations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transit_stations_line_idx" ON "transit_stations" USING btree ("line");