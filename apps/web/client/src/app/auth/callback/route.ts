import { client } from '@/utils/analytics/server';
import { createClient } from '@/utils/supabase/server';
import type { User } from '@onlook/db';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { api } from '~/trpc/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');

    if (code) {
        const supabase = await createClient();
        const { error, data } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            const forwardedHost = request.headers.get('x-forwarded-host'); // original origin before load balancer
            const isLocalEnv = process.env.NODE_ENV === 'development';
            const user = await getOrCreateUser(data.user);

            trackUserSignedIn(user.id, {
                name: data.user.user_metadata.name,
                email: data.user.email,
                avatar_url: data.user.user_metadata.avatar_url,
            });

            // Redirect to the redirect page which will handle the return URL
            if (isLocalEnv) {
                return NextResponse.redirect(`${origin}/auth/redirect`);
            } else if (forwardedHost) {
                return NextResponse.redirect(`https://${forwardedHost}/auth/redirect`);
            } else {
                return NextResponse.redirect(`${origin}/auth/redirect`);
            }
        }
        console.error(`Error exchanging code for session: ${error}`);
    }

    // return the user to an error page with instructions
    return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}

async function getOrCreateUser(user: SupabaseUser): Promise<User> {
    const existingUser = await api.user.getById(user.id);
    if (!existingUser) {
        console.log(`User ${user.id} not found, creating...`);
        const newUser = await api.user.create({
            id: user.id,
            name: user.user_metadata?.full_name || user.user_metadata?.name || user.email,
            email: user.email,
            avatarUrl: user.user_metadata?.avatar_url,
        })
        return newUser;
    }
    console.log(`User ${user.id} found, returning...`);
    return existingUser;
}

function trackUserSignedIn(userId: string, properties: Record<string, any>) {
    try {
        if (!client) {
            console.warn('PostHog client not found, skipping user signed in tracking');
            return;
        }
        client.identify({
            distinctId: userId,
            properties: {
                ...properties,
                $set_once: {
                    signup_date: new Date().toISOString(),
                }
            }
        });
        client.capture({ event: 'user_signed_in', distinctId: userId });
    } catch (error) {
        console.error('Error tracking user signed in:', error);
    }
}
