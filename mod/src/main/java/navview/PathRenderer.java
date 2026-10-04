package navview;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.entity.Entity;
import net.minecraftforge.client.event.RenderWorldLastEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import org.lwjgl.opengl.GL11;

import java.util.List;

// Same draw as BedwarsBot's path renderer: a translucent floor box on each
// remaining node, a smooth outline, and a line through the node centres.
final class PathRenderer {
    private static final float RED = 170F / 255F;
    private static final float GREEN = 85F / 255F;
    private static final float BLUE = 255F / 255F;
    private static final float FILL = 0.22F;
    private static final float LINE_WIDTH = 1.5F;
    private static final double PAD = 0.002;
    private static final double LINE_LIFT = 0.03;
    private static final double FADE_NEAR = 6;
    private static final double FADE_FAR = 36;

    @SubscribeEvent
    public void onRender (RenderWorldLastEvent event) {
        if (!NavView.enabled) return;
        PathSnapshot snap = PathClient.current();
        if (snap == null) return;
        if (snap.nodes.isEmpty() && snap.goal == null) return;

        Minecraft mc = Minecraft.getMinecraft();
        Entity view = mc.getRenderViewEntity();
        if (view == null) return;
        float partial = event.partialTicks;
        double ox = view.lastTickPosX + (view.posX - view.lastTickPosX) * partial;
        double oy = view.lastTickPosY + (view.posY - view.lastTickPosY) * partial;
        double oz = view.lastTickPosZ + (view.posZ - view.lastTickPosZ) * partial;

        GlStateManager.pushMatrix();
        GlStateManager.translate(-ox, -oy, -oz);
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        GlStateManager.disableTexture2D();
        GlStateManager.disableLighting();
        GlStateManager.disableCull();
        GlStateManager.enableDepth();
        GlStateManager.depthFunc(515);
        GlStateManager.depthMask(false);
        GL11.glEnable(GL11.GL_LINE_SMOOTH);
        GL11.glHint(GL11.GL_LINE_SMOOTH_HINT, GL11.GL_NICEST);
        try {
            draw(snap);
        } finally {
            GL11.glDisable(GL11.GL_LINE_SMOOTH);
            GL11.glLineWidth(1.0F);
            GlStateManager.depthMask(true);
            GlStateManager.enableDepth();
            GlStateManager.enableCull();
            GlStateManager.enableTexture2D();
            GlStateManager.color(1F, 1F, 1F, 1F);
            GlStateManager.disableBlend();
            GlStateManager.popMatrix();
        }
    }

    private void draw (PathSnapshot snap) {
        List<PathSnapshot.Node> nodes = snap.nodes;
        int[] shown = waypoints(nodes);
        int first = 0;
        int target = -1;
        for (int k = 0; k < shown.length; k++) {
            int index = nodes.get(shown[k]).index;
            if (index <= snap.cursor - 1) first = k;
            if (target < 0 && index >= snap.cursor) target = index;
        }

        if (first < shown.length) {
            PathSnapshot.Node origin = nodes.get(shown[first]);
            int shade = GL11.glGetInteger(GL11.GL_SHADE_MODEL);
            GL11.glShadeModel(GL11.GL_SMOOTH);
            GL11.glBegin(GL11.GL_QUADS);
            for (int k = first; k < shown.length; k++) {
                PathSnapshot.Node node = nodes.get(shown[k]);
                float fade = fade(origin, node.x, node.y, node.z);
                float alpha = (node.index == target ? Math.min(1F, FILL * 1.8F) : FILL) * fade;
                GL11.glColor4f(RED, GREEN, BLUE, alpha);
                double[] box = floorBox(node);
                quads(box[0], box[1], box[2], box[3], box[4], box[5]);
            }
            GL11.glEnd();

            GL11.glLineWidth(LINE_WIDTH);
            GL11.glBegin(GL11.GL_LINES);
            for (int k = first; k < shown.length; k++) {
                PathSnapshot.Node node = nodes.get(shown[k]);
                GL11.glColor4f(RED, GREEN, BLUE, fade(origin, node.x, node.y, node.z));
                double[] box = floorBox(node);
                edges(box[0], box[1], box[2], box[3], box[4], box[5]);
            }
            GL11.glEnd();

            GL11.glBegin(GL11.GL_LINE_STRIP);
            for (int k = first; k < shown.length; k++) {
                PathSnapshot.Node node = nodes.get(shown[k]);
                GL11.glColor4f(RED, GREEN, BLUE, fade(origin, node.x, node.y, node.z));
                GL11.glVertex3d(node.x, node.y + LINE_LIFT, node.z);
            }
            GL11.glEnd();
            GL11.glShadeModel(shade);

            if (snap.goal != null) {
                float fade = fade(origin, snap.goal[0], snap.goal[1], snap.goal[2]);
                int x = (int) Math.floor(snap.goal[0]);
                int y = (int) Math.floor(snap.goal[1]);
                int z = (int) Math.floor(snap.goal[2]);
                GL11.glColor4f(RED, GREEN, BLUE, FILL * 0.6F * fade);
                GL11.glBegin(GL11.GL_QUADS);
                quads(x, y, z, x + 1, y + 2, z + 1);
                GL11.glEnd();
                GL11.glColor4f(RED, GREEN, BLUE, fade);
                GL11.glBegin(GL11.GL_LINES);
                edges(x, y, z, x + 1, y + 2, z + 1);
                GL11.glEnd();
            }
        } else if (snap.goal != null) {
            int x = (int) Math.floor(snap.goal[0]);
            int y = (int) Math.floor(snap.goal[1]);
            int z = (int) Math.floor(snap.goal[2]);
            GL11.glColor4f(RED, GREEN, BLUE, FILL * 0.6F);
            GL11.glBegin(GL11.GL_QUADS);
            quads(x, y, z, x + 1, y + 2, z + 1);
            GL11.glEnd();
            GL11.glColor4f(RED, GREEN, BLUE, 1F);
            GL11.glBegin(GL11.GL_LINES);
            edges(x, y, z, x + 1, y + 2, z + 1);
            GL11.glEnd();
        }
    }

    // Full strength next to the bot, easing out along the route.
    private static float fade (PathSnapshot.Node origin, double x, double y, double z) {
        double dx = x - origin.x;
        double dy = y - origin.y;
        double dz = z - origin.z;
        double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= FADE_NEAR) return 1F;
        if (dist >= FADE_FAR) return 0.08F;
        float t = (float) ((dist - FADE_NEAR) / (FADE_FAR - FADE_NEAR));
        t = t * t * (3F - 2F * t);
        return 1F - 0.92F * t;
    }

    // Straight walk runs keep the first and last block. Jumps, drops and
    // other non-walk nodes stay. This is only which boxes get drawn.
    private static int[] waypoints (List<PathSnapshot.Node> nodes) {
        int n = nodes.size();
        if (n == 0) return new int[0];
        int[] out = new int[n];
        int count = 0;
        out[count++] = 0;
        int i = 0;
        while (i < n - 1) {
            int next = i + 1;
            if (!special(nodes.get(next))) {
                for (int j = i + 2; j < n; j++) {
                    if (special(nodes.get(j))) break;
                    if (!onLine(nodes.get(i), nodes.get(i + 1), nodes.get(j))) break;
                    next = j;
                }
            }
            out[count++] = next;
            i = next;
        }
        int[] shown = new int[count];
        System.arraycopy(out, 0, shown, 0, count);
        return shown;
    }

    private static boolean special (PathSnapshot.Node node) {
        if (node.anchor) return true;
        return node.kind != null && !node.kind.equals("walk") && !node.kind.equals("start");
    }

    private static boolean onLine (PathSnapshot.Node a, PathSnapshot.Node b, PathSnapshot.Node c) {
        double ax = b.x - a.x;
        double ay = b.y - a.y;
        double az = b.z - a.z;
        double bx = c.x - a.x;
        double by = c.y - a.y;
        double bz = c.z - a.z;
        double cx = ay * bz - az * by;
        double cy = az * bx - ax * bz;
        double cz = ax * by - ay * bx;
        if (cx * cx + cy * cy + cz * cz > 1.0E-4) return false;
        return ax * bx + ay * by + az * bz > 0;
    }

    // Floor highlight: the block under the feet, or just the slab when the
    // standing height is not a whole block.
    private static double[] floorBox (PathSnapshot.Node node) {
        int x = (int) Math.floor(node.x);
        int z = (int) Math.floor(node.z);
        int y = (int) Math.floor(node.y);
        double slab = node.y - y;
        double bottom = slab > 0.01 ? y : y - 1;
        return new double[] {
            x - PAD, bottom - PAD, z - PAD,
            x + 1 + PAD, node.y + PAD, z + 1 + PAD
        };
    }

    private static void quads (double x0, double y0, double z0, double x1, double y1, double z1) {
        GL11.glVertex3d(x0, y0, z0);
        GL11.glVertex3d(x1, y0, z0);
        GL11.glVertex3d(x1, y0, z1);
        GL11.glVertex3d(x0, y0, z1);

        GL11.glVertex3d(x0, y1, z0);
        GL11.glVertex3d(x0, y1, z1);
        GL11.glVertex3d(x1, y1, z1);
        GL11.glVertex3d(x1, y1, z0);

        GL11.glVertex3d(x0, y0, z0);
        GL11.glVertex3d(x0, y1, z0);
        GL11.glVertex3d(x1, y1, z0);
        GL11.glVertex3d(x1, y0, z0);

        GL11.glVertex3d(x0, y0, z1);
        GL11.glVertex3d(x1, y0, z1);
        GL11.glVertex3d(x1, y1, z1);
        GL11.glVertex3d(x0, y1, z1);

        GL11.glVertex3d(x0, y0, z0);
        GL11.glVertex3d(x0, y0, z1);
        GL11.glVertex3d(x0, y1, z1);
        GL11.glVertex3d(x0, y1, z0);

        GL11.glVertex3d(x1, y0, z0);
        GL11.glVertex3d(x1, y1, z0);
        GL11.glVertex3d(x1, y1, z1);
        GL11.glVertex3d(x1, y0, z1);
    }

    private static void edges (double x0, double y0, double z0, double x1, double y1, double z1) {
        line(x0, y0, z0, x1, y0, z0);
        line(x1, y0, z0, x1, y0, z1);
        line(x1, y0, z1, x0, y0, z1);
        line(x0, y0, z1, x0, y0, z0);
        line(x0, y1, z0, x1, y1, z0);
        line(x1, y1, z0, x1, y1, z1);
        line(x1, y1, z1, x0, y1, z1);
        line(x0, y1, z1, x0, y1, z0);
        line(x0, y0, z0, x0, y1, z0);
        line(x1, y0, z0, x1, y1, z0);
        line(x1, y0, z1, x1, y1, z1);
        line(x0, y0, z1, x0, y1, z1);
    }

    private static void line (double x0, double y0, double z0, double x1, double y1, double z1) {
        GL11.glVertex3d(x0, y0, z0);
        GL11.glVertex3d(x1, y1, z1);
    }
}
