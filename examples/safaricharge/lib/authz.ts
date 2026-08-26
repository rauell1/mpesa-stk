/**
 * Stand-in for the app's real authorization layer.
 *
 * The point of the file is that it exists: `organizationId` arrives in the
 * request body, so something has to confirm the caller belongs to it before a
 * payment is initiated against their shortcode. In SafariCharge this reads the
 * session and checks organization_members.
 */

export async function requireOrgMember(_organizationId: string): Promise<boolean> {
  throw new Error('Wire this to your session and membership check')
}
